import { type Request, type Response } from "express";
import { SearchService } from "../services/search.service.js";
import ApiResponse from "../utils/api-response.js";
import ApiError from "../utils/api-error.js";

export const searchController = async (
  req: Request,
  res: Response
) => {
  try {
    const query = req.query.q;

    if (typeof query !== "string" || !query.trim()) {
      throw new ApiError(
        400,
        "Search query is required"
      );
    }

    const searchService = new SearchService();

    const data = await searchService.search(query);

    const urls = data.results
      .map((result) => result.url)
      .filter(
        (url): url is string =>
          typeof url === "string"
      );

    return res.status(200).json(
      new ApiResponse(
        200,
        "Search successful",
        {
          query,
          urls,
        }
      )
    );

  } catch (error) {
    console.error("Search error:", error);

    if (error instanceof ApiError) {
      return res.status(error.statusCode).json(
        new ApiResponse(
          error.statusCode,
          error.message,
          error.errors
        )
      );
    }

    return res.status(500).json(
      new ApiResponse(
        500,
        "Search failed",
        null
      )
    );
  }
};