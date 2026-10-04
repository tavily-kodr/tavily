import express from "express";
import { searchController } from "../controllers/search.contorller.js";

const router = express.Router();

router.get("/", searchController);

export default router