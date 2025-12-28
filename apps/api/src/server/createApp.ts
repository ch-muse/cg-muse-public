import express from "express";
import type { AppContext } from "./context.js";
import { registerRoutes } from "./registerRoutes.js";

export const createApp = (context: AppContext) => {
  const app = express();
  registerRoutes(app, context);
  return app;
};
