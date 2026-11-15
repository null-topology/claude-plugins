---
allow:
  - "mcp__tickets__search_*"
  - "mcp__tickets__get_*"
deny:
  - "mcp__tickets__get_attachment"
---
# Synthetic example — not an instruction to access a real tracker

## Objective
List the open tickets of the example project PAY that carry the label `refund` and have had no comment for 14 days or more.

## Context and Evidence
The tracker is reached only through the MCP server `tickets`. Project key: PAY. "Open" means any status except Done and Won't Do. The date that counts is the latest comment date the tracker returns, not the ticket's update date.

## Scope Boundary
Read tickets of project PAY through the `tickets` server: search and read. No ticket is created, changed, commented on or moved, and no attachment is opened: attachments are not needed and may hold customer data. While the global allow list is empty, the block above admits only the `tickets` tools whose names start with `search_` or `get_`, and its deny rule refuses `get_attachment` among them; any other tool stays out of scope even where the global lists or another route would reach it. No other projects, trackers or MCP servers. No further delegation.

## Epistemic Boundary
Claims describe the tracker as returned during this run. A ticket the search did not return is not proof that none exists: report the query and whether every page was read. A ticket whose comments could not be read is listed as unresolved, not as quiet.

## Acceptance Criteria
Every listed ticket is open, in PAY, labelled `refund`, and its latest comment is at least 14 days old, with the date shown. The search reached its last page, or the gap is named.

## Return and Stop
Return a table of key, summary, status and latest comment date, then the query used and the coverage. Stop when the table is complete. Stop and report instead when a tool the work needs is refused: a refused MCP call is final.
