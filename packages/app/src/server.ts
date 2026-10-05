import express from "express";

import searchRoutes from "./routes/search.route.js"

// Load .env from the package root (see .env.example). Skipped when absent so the
// process can be configured purely through real environment variables.
try {
  process.loadEnvFile();
} catch {
  // no .env file
}

const app = express();

const PORT: number = Number(process.env.PORT) || 3000;

app.use(express.json());

app.get("/", (req, res) => {
  res.json({
    message: "Server is running "
  });
});

app.use("/search", searchRoutes );

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});

export default app;
