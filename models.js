// Lists the model IDs the configured key can actually reach: `npm run models`.
// Useful because a provider's docs and its live catalogue often disagree.
import { client, PROVIDER, BASE_URL, MODEL } from "./provider.js";

console.log(`Provider: ${PROVIDER}  Base: ${BASE_URL}`);

try {
  const { data } = await client.models.list();
  const ids = data.map((m) => m.id).sort();

  if (ids.length === 0) {
    console.log("No models returned — the endpoint answered but the list was empty.");
  } else {
    console.log(`\n${ids.length} model(s) available:`);
    for (const id of ids) console.log(`  ${id}${id === MODEL ? "   <- configured MODEL" : ""}`);
  }

  if (!ids.includes(MODEL)) {
    console.log(`\nHeads up: configured MODEL "${MODEL}" is not in this list.`);
    console.log("Set MODEL in .env to one of the IDs above.");
  }
} catch (err) {
  console.error(`\nCould not list models: ${err.status ?? ""} ${err.message}`);
  console.error("Some providers do not expose /models; that alone does not mean the key is bad.");
  process.exit(1);
}
