import { IdempotencyStore } from "../../src/index.ts";
import { serve } from "./bunServer.ts";
import { idempotencyScenarios } from "./scenarios.ts";

idempotencyScenarios(
  "Bun.serve with HttpRouter.toWebHandler",
  serve(IdempotencyStore.layerMemory),
);
