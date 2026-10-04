import express from "express";

import searchRoutes from "./routes/search.route.js"

const app = express();

const PORT: number = 3000;

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