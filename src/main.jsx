import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import Ambigram from "../ambigram.jsx";

createRoot(document.getElementById("root")).render(
  <StrictMode>
    <Ambigram />
  </StrictMode>
);
