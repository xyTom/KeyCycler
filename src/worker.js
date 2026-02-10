import { handleFetch } from "./handlers/fetch.js";
import { handleQueue } from "./handlers/queue.js";

export { KeyShardV2 } from "./do/KeyShard.js";

export default {
  fetch: handleFetch,
  queue: handleQueue,
};
