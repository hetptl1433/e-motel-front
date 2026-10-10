# E-motel / Super 8 housekeeping

Daily flow: front desk signs in → uploads the morning Super 8 Room Status PDF once → rooms appear on both live boards → front desk taps **Check out** when a guest leaves → housekeeping taps **Mark done** after cleaning → front desk sees the change immediately.

The PDF importer is a deterministic, local parser for the format in `Backend/reports/AAsamplw.pdf` (Super 8 by Wyndham Shipshewana). It reads all pages, maps cells by their column coordinates, keeps multiline notes and pet markers, and normalizes stay dates using the printed report year. No OpenAI, Textract, S3, or Cloudinary service is required. Scanned/image-only PDFs and other layouts receive a clear error. CSV/JSON imports are also supported with the room fields `room`, `type`, `housekeepingStatus`, `occupancyStatus`, `checkIn`, `checkOut`, `notes`, and `pet`.

## Run

Use Node 20 or 22. Install dependencies in both projects:

```sh
npm --prefix Backend install
npm --prefix HK/L1/l1 install
```

Keep your existing `.env` files. For a new setup, copy the `.env.example` in each project to `.env`, choose a MongoDB connection string, and set a long random `JWT_SECRET`. Run MongoDB locally or use an available Atlas database.

```sh
npm run dev
```

Open http://127.0.0.1:3000. The API uses http://127.0.0.1:4000/api. Stop existing servers on those ports before starting another copy. You can also start each project separately with `npm --prefix Backend run dev` and `npm --prefix HK/L1/l1 start`. The health endpoint `/api/health` returns 200 when MongoDB is connected, or 503 with a useful status when it is unavailable.

Create an account with `npm --prefix Backend run create-user -- <ID> <role>` after setting `MOTEL_USER_PASSWORD` in your environment. Roles are `admin`, `frontdesk`, and `housekeeping`. Account creation never changes an existing user's password. Optional `npm --prefix Backend run seed` requires `MOTEL_SEED_PASSWORD`; it adds the sample and missing development users without deleting records.

## Deploy on Vercel

Deploy from the repository root, leaving Vercel's Root Directory at `.`. The committed `vercel.json` installs both projects, builds the React frontend into `HK/L1/l1/build`, routes `/api/*` and `/socket.io/*` to the shared HTTP server, and supports direct links to each app page. Fluid Compute must stay enabled for WebSocket connections.

Set `MONGODB_URI` and a long random `JWT_SECRET` in the Vercel project for Production and Preview. Transfer of existing local credentials requires your approval. Use MongoDB Atlas or another replica set/sharded cluster with network access from Vercel and permission to create indexes, write events, and open change streams. The MongoDB Socket.IO adapter shares updates between function instances; a standalone MongoDB server cannot support this hosted live mode. `/api/health` reports whether both database and live infrastructure are ready. Add custom frontend domains to comma-separated `CLIENT_ORIGINS`; Vercel deployment and production domains are recognized automatically.

The `e-motel-front` Vercel project is connected to `hetptl1433/e-motel-front`, with `main` as its production branch. Pushing a commit to `main` starts a production deployment automatically.

Production builds use the same origin for `/api` and WebSocket-only Socket.IO at `/socket.io`, so no frontend endpoint overrides are needed. Local development keeps its localhost API and polling-to-WebSocket upgrade. `REACT_APP_*` values are public build settings; keep MongoDB credentials and `JWT_SECRET` only in backend environment variables.

Hosted report uploads allow up to **4 MB**; local uploads allow **10 MB**. On Vercel, original PDFs are stored in MongoDB, and a shared lock for each report date prevents overlapping imports across instances. No persistent local reports directory is needed for hosted uploads.

## Workflows

Choose the PDF's printed report date when uploading. A successful upload creates or refreshes housekeeping rooms automatically; there is no second import step. Reuploading that date updates source metadata without duplicating rooms or erasing existing cleaning status, notes, and assignments. Other dates are preserved. If an upload saves the report but cannot refresh housekeeping, the page shows a warning and asks staff to retry the upload.

Front desk/admin accounts open **Front desk**, use **Upload PDF**, and tap **Check out** when a guest leaves. Checkout uses `POST /api/room/:id/checkout`, changes the room to vacant and dirty, and makes it ready for housekeeping. Housekeeping accounts open a simple board with large room buttons and tap **Mark done** after cleaning. Occupied rooms cannot be marked clean by housekeeping; front desk must check them out first. Room and housekeeping changes synchronize for the same room and report date through authenticated Socket.IO sessions that reconnect automatically.

Housekeeping uses full-width room entries on phones, readable notes and pet flags, cleaning progress, and 48px completion buttons with Undo. Front desk offers **Table** and **Boxes** layouts beside room search and remembers the choice in the browser. Both include status totals, guest/stay information, attendant assignments, full notes, and direct checkout/edit controls; they adapt to stacked entries on phones. Switching layouts preserves filters, live room data and unsaved edits. Advanced filters and report tools stay in a disclosure. An active edit stays visible if another staff member changes its status, and saving sends only changed fields to preserve concurrent work.

Live connections stay open when changing report dates. Missed changes are refreshed after reconnecting or returning to the page, with 30-second checks while the connection is unavailable. Out-of-date events cannot overwrite newer room records. The connection label reports when the boards are live or reconnecting.

Room colors and labels use the same meaning on both boards:

- **Red:** vacant and dirty — ready to clean.
- **Yellow:** occupied — waiting for checkout.
- **Green:** vacant and clean — done.
- **Gray:** unavailable — out of order or out of service.

Housekeeping navigation contains only **Housekeeping** and **Sign out**. Front desk/admin navigation includes **Front desk**, **Housekeeping**, **Upload PDF**, and a secondary **Room sheets** link. Downloads remain optional after the live work is complete.

Room sheets are downloaded through authenticated API requests; generated sheets reflect current room records. Original PDFs are retained in MongoDB on Vercel and in `Backend/reports` during local development. Uploaded local originals and temporary files are ignored by Git. Other deployments using local report storage must persist that directory.

New logins last 365 days and are remembered in the browser until sign-out or expiry. Older tokens keep their original expiry; sign in once to obtain the new duration. The account and current role are still checked by the backend.

## Verify

```sh
npm test
npm run build
```

Regression tests cover PDF parsing, malformed imports, date isolation, repeated imports, permissions, login, layouts, live recovery, hosted endpoints, and upload limits. Unit tests run offline; database integration tests are skipped unless `TEST_MONGO_URI` is set. Runtime workflows require MongoDB. After deploying, check `/api/health`, sign in, verify room changes between two sessions, and download original/generated sheets.

Original motel PDFs and database exports stay private and are excluded from this public repository. Three additional regression checks use local fixtures at `Backend/reports/AAsamplw.pdf` and `Backend/room_sheet.pdf`; they run when those files exist and otherwise report a clear skip reason. A clean clone runs the synthetic PDF/parser/import/storage tests without those originals. The optional seed command also requires the local sample PDF.
