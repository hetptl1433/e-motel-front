# E-motel workspace design

Visual references: `frontdesk-concept.png` and `housekeeping-concept.png`, created with the built-in image-generation tool.

The concept briefs requested a complete desktop front desk room table and a mobile housekeeping task list. Both preserve the existing report-date, checkout, completion, notes, assignment, import and authorization workflows. Text and controls are implemented as React/HTML; these PNGs are design references only.

## Tokens and components

- Cool gray page `#f5f7fa`, white surface `#fff`, navy text `#172b4d`, muted text `#64748b`, border `#dce3ed`, action blue `#2563eb`.
- System sans typography: 32px desktop / 28px mobile page titles, 22px section titles, 13–15px operational text, 32px housekeeping room numbers, 20px desktop room numbers.
- 12px surface corners, 8px controls, 16px mobile gutters, 40px desktop gutters, 48px housekeeping action targets.
- Shared horizontal navigation, status totals, underline filter tabs, colored status labels, room search, report-date controls, disclosure filters, inline notices, room editor and error/empty states.
- Housekeeping uses one full-width room entry on phones and two columns on wider screens. Front desk uses six aligned table-style columns on desktop and stacked room entries below 800px.
- Front desk also offers a Table / Boxes switch beside room search. Boxes use a responsive grid of individual room cards with large room numbers, status, guest/stay, attendant, full notes and checkout/edit actions. The browser remembers the choice. Both layouts share the same filters, live data and active draft; switching views does not reload rooms or discard edits. An editing card spans the grid so all form fields remain comfortable to use.

## Content and workflows

Headings: Housekeeping, Cleaning progress, Room list, Front desk, Room board. Primary actions: Mark done, Undo room, Check out, Edit, Save, Upload morning PDF, Refresh rooms. Status labels: All rooms, Ready to clean, Waiting for checkout, Done, Unavailable. Navigation: Front desk, Housekeeping, Upload PDF, Room sheets, Sign out, limited by existing role permissions.

Intentional adjustments to generated references: remove invented Dashboard/Rooms/Reports mobile navigation; retain authorized app navigation. Keep the complete Waiting for checkout label rather than shorten it. Retain one existing More filters and report tools disclosure, plus previous/next/Today date controls, instead of creating unrelated tools or sortable column controls. Counts, dates and room details always come from application data. All room notes remain readable rather than truncated.

Live events share existing authenticated Socket.IO sessions. Updates apply only to the displayed report date, older versions cannot overwrite newer records, and reconnecting refreshes the authoritative board. When disconnected, the connection label explains the 30-second fallback checks.
