const express = require("express");
const multer = require("multer");
const { OpenAI } = require("openai");
const dotenv = require("dotenv");
const fs = require("fs");
const path = require('path');
const e = require("express");
const FormData = require('form-data');
const axios = require('axios');
const { MongoClient } = require('mongodb');

// Load environment variables
dotenv.config();
const uri = process.env.DB_LOCAL_CONNECTION;

// Initialize OpenAI client
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// Initialize Express app
const app = express();

// Create a MongoClient and connect to MongoDB
const client = new MongoClient(uri, {});

// Connect to the database
client.connect()
  .then(() => console.log('Connected to MongoDB!'))
  .catch((err) => console.error('Failed to connect to MongoDB', err));

// Select the database
const db = client.db('ecommerce'); // Use your database name
const filesCollection = db.collection('files'); // Files collection
const feedbackCollection = db.collection('feedback'); // Feedback collection

// Setup multer for file upload
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, 'uploads/'); // The folder where files will be saved
  },
  filename: function (req, file, cb) {
    const fileExtension = path.extname(file.originalname); // Get file extension
    cb(null, Date.now() + fileExtension); // Generate a unique filename
  },
});

const upload = multer({ storage: storage });

// Middleware to parse JSON
app.use(express.json());

// Endpoint to upload a file and attach it to the existing assistant
app.post("/upload", upload.single("file"), async (req, res) => {

  // Create form-data instance for the outgoing request
  const formData = new FormData();
  formData.append('file', fs.createReadStream(req.file.path)); // Use the file from local disk

  // Send the file to another API (could be your own upload endpoint or external)
  const ocr = await axios.post(`${process.env.ENDPOINT_OCR}/api/ocr`, formData, {
    headers: {
      ...formData.getHeaders(),  // Add headers required for form-data
    },
  });

  const filePath = saveBase64AsFile(ocr.data.data, ocr.data.filename, ocr.data.content_type);

  try {
    // Step 1: Upload the file to OpenAI
    const file = await openai.files.create({
      file: fs.createReadStream(filePath),
      purpose: "assistants",
    });

    // Step 2: Attach the file to the existing assistant
    const assistant = await openai.beta.assistants.update(
      process.env.ASSISTANT_ID, // Use your existing assistant ID
      {
        file_ids: [file.id], // Attach the uploaded file
      }
    );

    // Step 3: Create vector store
    await openai.beta.vectorStores.files.create(
      process.env.VECTOR_STORE_ID,
      {
        file_id: file.id,
      }
    );

    // Clean up: Delete the uploaded file from the server
    fs.unlinkSync(req.file.path);

    // Save to database
    await filesCollection.insertOne({
      name: req.body.name,
      originalFilename: ocr.data.filename,
      file_id: file.id,
      createdAt: new Date(),
      updatedAt: new Date()
    });

    // Respond with success and file ID
    res.status(200).json({ message: "File uploaded and attached to assistant", fileId: file.id });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Endpoint to ask a question to the assistant
app.post("/ask", async (req, res) => {
  const { threadId, question } = req.body;

  try {
    // Step 1: Create or reuse a thread
    let thread;
    if (!threadId) {
      thread = await openai.beta.threads.create();
    } else {
      thread = { id: threadId };
    }

    // Step 2: Add the user's question to the thread
    await openai.beta.threads.messages.create(thread.id, {
      role: "user",
      content: question,
    });

    // Step 3: Run the assistant
    const run = await openai.beta.threads.runs.create(thread.id, {
      assistant_id: process.env.ASSISTANT_ID,
    });

    // Step 4: Wait for the run to complete
    let runStatus;
    do {
      await new Promise((resolve) => setTimeout(resolve, 2000)); // Poll every 2 seconds
      runStatus = await openai.beta.threads.runs.retrieve(thread.id, run.id);
      console.log("Run Status:", runStatus.status); // Log the status
    } while (runStatus.status !== "completed");

    // Step 5: Retrieve the assistant's response
    const messages = await openai.beta.threads.messages.list(thread.id);
    const assistantResponse = messages.data[0].content[0].text.value;

    // Step 6: Respond to the client
    res.status(200).json({ response: assistantResponse, threadId: thread.id });
  } catch (error) {
    res.status(500).json({ error: "Something went wrong" });
  }
});

// Endpoint to get file list
app.get("/files", async (req, res) => {

  const query = req.query;

  try {
    const files = await filesCollection.find(query).sort({ createdAt: -1 }).toArray();

    res.status(200).json({ message: "Files retrieved", data: files });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Endpoint to get file details
app.get("/files/:fileId", async (req, res) => {

  const params = req.params;

  try {
    const file = await filesCollection.findOne({ file_id: params.fileId });

    res.status(200).json({ message: "File retrieved", data: file });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Endpoint to delete file
app.delete("/files/:fileId", async (req, res) => {

  const params = req.params;

  try {
    const file = await filesCollection.deleteOne({ file_id: params.fileId });
    await openai.beta.vectorStores.files.del(
      process.env.VECTOR_STORE_ID,
      params.fileId
    );

    res.status(200).json({ message: "File deleted", data: file });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Endpoint to update file
app.patch("/files/:fileId", async (req, res) => {

  const params = req.params;
  const { name, file_id } = req.body

  try {
    const file = await filesCollection.updateOne(
      { file_id: params.fileId },
      {
        $set: {
          name,
          file_id,
          updatedAt: new Date()
        }
      }
    );

    res.status(200).json({ message: "File updated", data: file });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Endpoint to create feedback
app.post("/feedback", async (req, res) => {
  const { reason, rating, threadId } = req.body;

  try {
    const createFeedback = await feedbackCollection.insertOne({
      reason,
      rating,
      threadId,
      createdAt: new Date(),
      updatedAt: new Date()
    });

    res.status(200).json({ message: "Feedback created", data: createFeedback });
  } catch (error) {
    res.status(500).json({ error: "Something went wrong" });
  }
});

// Endpoint to get feedback list
app.get("/feedback", async (req, res) => {
  const query = req.query;

  try {
    const feedback = await feedbackCollection.find(query).sort({createdAt: -1}).toArray();
    res.status(200).json({ message: "Feedback created", data: feedback });
  } catch (error) {
    res.status(500).json({ error: "Something went wrong" });
  }
});

// Endpoint to get feedback details
app.get("/feedback/:threadId", async (req, res) => {
  const params = req.params;

  try {
    const feedback = await feedbackCollection.findOne({threadId: params.threadId});
    const messages = await openai.beta.threads.messages.list(
      params.threadId
    );
    res.status(200).json({ message: "Feedback created", data: feedback, chat_histories: messages.body?.data });
  } catch (error) {
    res.status(500).json({ error: "Something went wrong" });
  }
});

// Endpoint to get feedback summary
app.get("/feedback-summary/", async (req, res) => {
  try {
    const totalYes = await feedbackCollection.countDocuments({rating: true});
    const totalNo = await feedbackCollection.countDocuments({rating: false});
    res.status(200).json({ message: "Feedback retrieved", data: { totalYes, totalNo, total: totalYes + totalNo } });
  } catch (error) {
    res.status(500).json({ error: "Something went wrong" });
  }
});

// Function to save a base64 string as a file, keeping original name and format
function saveBase64AsFile(base64String, originalName, fileFormat) {
  // Convert base64 string to buffer
  const buffer = Buffer.from(base64String, 'base64');

  // Get the file extension from the original name if needed
  const extension = fileFormat || path.extname(originalName);

  // Create a file path with the original file name and extension
  const filePath = path.join(__dirname, 'uploads', originalName);

  // Write the buffer to a file
  fs.writeFileSync(filePath, buffer);

  return filePath;
}

// Start the server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});