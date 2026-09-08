import { openapi } from "@elysiajs/openapi";
import { Elysia } from "elysia";
import { ErrorBody, ListQuery, NewTicket, Page, Ticket, type TicketRepo } from "./tickets";

const notFound = (message: string) => ({ error: { code: "not_found", message } });

export function createApp(repo: TicketRepo) {
  return (
    new Elysia({ serve: { maxRequestBodySize: 64 * 1024 } })
      // One error shape for every failure; internal messages stay in the log.
      .onError(({ code, error, status }) => {
        if (code === "VALIDATION" && error.type !== "response") {
          // Prefer the message declared on the schema (see `oneOf`); fall back to Elysia's summary.
          const details = error.all.map((e) => ({
            path: e.path,
            message: typeof e.schema?.error === "string" ? e.schema.error : e.summary,
          }));
          return status(422, {
            error: { code: "validation", message: "invalid request", details },
          });
        }
        if (code === "PARSE")
          return status(400, { error: { code: "bad_request", message: "malformed JSON body" } });
        if (code === "NOT_FOUND") return status(404, notFound("not found"));
        console.error(error);
        return status(500, { error: { code: "internal", message: "internal error" } });
      })
      .use(
        openapi({
          documentation: {
            info: {
              title: "Ticket classifier",
              version: "1.0.0",
              description: "Ingest support tickets; read back their LLM classification.",
            },
          },
        }),
      )
      .group("/v1", (v1) =>
        v1
          .post(
            "/tickets",
            ({ body, set, status }) => {
              const { ticket, created } = repo.insertIfAbsent(body);
              set.headers.location = `/v1/tickets/${encodeURIComponent(ticket.id)}`;
              return status(created ? 201 : 200, ticket);
            },
            {
              body: NewTicket,
              response: {
                200: Ticket,
                201: Ticket,
                400: ErrorBody,
                422: ErrorBody,
                500: ErrorBody,
              },
              detail: {
                summary: "Ingest a ticket",
                description:
                  "201 on first submission; 200 with the stored ticket if the id was seen before.",
              },
            },
          )
          .get(
            "/tickets/:id",
            ({ params, status }) =>
              repo.get(params.id) ?? status(404, notFound("ticket not found")),
            {
              response: { 200: Ticket, 404: ErrorBody, 500: ErrorBody },
              detail: { summary: "Fetch one ticket" },
            },
          )
          .get("/tickets", ({ query }) => repo.list(query), {
            query: ListQuery,
            response: { 200: Page, 422: ErrorBody, 500: ErrorBody },
            detail: { summary: "List tickets, filtered and paginated, newest first" },
          }),
      )
  );
}
