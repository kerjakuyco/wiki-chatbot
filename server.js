const express = require("express");
const multer = require("multer");
const { OpenAI } = require("openai");
const dotenv = require("dotenv");
const fs = require("fs");
const path = require('path');
const e = require("express");

// Load environment variables
dotenv.config();

// Initialize OpenAI client
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// Initialize Express app
const app = express();
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
  try {
    // Step 1: Upload the file to OpenAI
    const file = await openai.files.create({
      file: fs.createReadStream(req.file.path),
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
    // console.log("Messages:", JSON.stringify(messages.data)); // Log all messages for debugging

    const assistantResponse = messages.data[0].content[0].text.value;

    // Step 6: Respond to the client
    res.status(200).json({ response: assistantResponse, threadId: thread.id });
  } catch (error) {
    res.status(500).json({ error: "Something went wrong" });
  }
});

// Start the server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});