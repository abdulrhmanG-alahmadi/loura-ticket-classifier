/** Load the sample tickets through the public API: `bun run seed [baseUrl]`. */
import tickets from "../data/tickets.json";

const base = process.argv[2] ?? `http://localhost:${process.env.PORT ?? 3000}`;

for (const ticket of tickets) {
  const res = await fetch(`${base}/v1/tickets`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(ticket),
  });
  const outcome =
    res.status === 201 ? "created" : res.status === 200 ? "already exists" : `HTTP ${res.status}`;
  console.log(`${ticket.id}: ${outcome}`);
}
