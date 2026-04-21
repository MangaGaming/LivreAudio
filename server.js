import express from "express";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = 3000;

// Serve static files from root
app.use(express.static(__dirname));

// Fallback to index.html for SPA behavior
app.get("*", (req, res) => {
    res.sendFile(path.join(__dirname, "index.html"));
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Development server running at http://localhost:${PORT}`);
  console.log("Strictly Client-Side Architecture active.");
});
