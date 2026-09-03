# Sections

The section ID (in parentheses) is the filename prefix used to group rules.
Rules are sorted by title within a section. Files starting with `_` are not rules.

---

## 1. Server Payload & Waterfalls (payload)

**Impact:** CRITICAL
**Description:** gemi renders on the server and ships a data payload with the HTML. Every read the client discovers only after hydration costs a full round-trip the payload could have carried. This is the largest lever in the app.

## 2. Client Data Fetching (query)

**Impact:** CRITICAL
**Description:** `useQuery` defaults (suspense on, keepPreviousData on, 5s staleTime, focus revalidation off) are opinionated. Fighting them — or not knowing them — produces blank flashes, dead pagination, and duplicate requests.

## 3. Data Access — ORM (orm)

**Impact:** HIGH
**Description:** The ORM is Prisma-typed but gemi-executed, with its own relation-loading strategies, transaction semantics, connection selection, and row-provenance model. Its constraints are not Prisma's.

## 4. Routing & Middleware (routing)

**Impact:** HIGH
**Description:** Routing is class-based: routers declare a routes object, and middleware attaches as a string DSL. This is where a URL, its cache policy, and its auth boundary are all defined.

## 5. Controllers & Request Handling (controller)

**Impact:** HIGH
**Description:** Controllers hold server logic and own the request boundary — validation, authorization, error shape. The client's error handling is a contract with what a controller throws.

## 6. Services, Jobs & Commands (service)

**Impact:** HIGH
**Description:** Long-lived singletons, background work, and one-off ops. Most failures here are invisible in development and appear only in the production build or on a restart.

## 7. Client Components & Navigation (client)

**Impact:** MEDIUM
**Description:** React 19 SSR with hydration. Typed navigation, forms, suspense boundaries declared by route module exports, and data flow that does not go through effects.

## 8. Bundle Size (bundle)

**Impact:** MEDIUM
**Description:** Vite code-splits per route chunk. Client cost is determined by which module graph a route pulls in and where a heavy subtree is mounted.

## 9. Internationalization (i18n)

**Impact:** MEDIUM
**Description:** Two dictionary systems coexist. The newer one is rewritten at build time by a Vite plugin, which constrains how it may be written.

## 10. Testing (testing)

**Impact:** MEDIUM
**Description:** Views mount for real with seeded framework inputs, through `<Page>` from `gemi/testing`. Match whichever runner and naming convention the directory already uses — a test the runner never selects is a test that does not exist.
