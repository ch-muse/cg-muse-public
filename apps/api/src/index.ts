import dotenv from "dotenv";
import { createApp } from "./server/createApp.js";
import { createContext } from "./server/context.js";

dotenv.config();

const context = createContext();
const app = createApp(context);

app.listen(context.port, () => {
  console.log(`API listening on http://localhost:${context.port}`);
});
