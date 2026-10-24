# Live Nation sources for the Tour Settlements Officer seat

These are the facts the seat's company data, policies and answer keys may cite, quoted from the real public documents the team collected. Anything not listed here is simulated and must be labeled as simulated (section 9).

Paths are relative to the team's research folder, `$R/hyphenate/research/`. `$R` is `~/Documents/calhacks/calhacks_extracted/calhacks` where `calhacks.tar.xz` was extracted, or `~/Code/hackathons/calhacks` in the original checkout. That folder is not in this repo. Line numbers refer to its files.

## 1. The seat: Tour Settlements Officer, Live Nation Australasia (JR-93271)

[Job posting](https://livenation.wd503.myworkdayjobs.com/en-US/LNExternalSite/job/Tour-Settlements-Officer_JR-93271), extract `source-extracts/live-nation-tour-settlements-officer.txt`, fetched 2026-10-16 ("Posted 28 Days Ago", line 18).

| Line | Exact wording | What gram builds from it |
|---|---|---|
| 12, 31 | "Live Nation Australasia Melbourne"; "Tour Settlements Officer (Assistant Accountant) to join Live Nation's Touring Finance team in Melbourne." | The seat profile. |
| 33 | "…the settlements process for concerts and tours across Australia and New Zealand, working closely with Tour Accountants and Promoters…" | Books in AUD, New Zealand shows in NZD. The people are a Tour Accountant and a Promoter. |
| 33 | "…ensuring cash deposits are correctly allocated and that all supporting documentation is in order." | Each bank deposit becomes a work item, allocated to the show settlement it pays, with its documents attached. |
| 39 | "Settlement accuracy: Ensure correct GL coding and cash receipting of venue settlements." | Each proposal carries a GL account; policies learn the coding from past tours. |
| 40 | "Invoice compliance: Check invoice operational approvals are compliant with approval limits before approving in the invoice workflow platform." | Approval limits enforced in code; whoever proposes cannot approve. The limit amounts are not public (section 9). |
| 41 | "Documentation management: Ensure all event related invoices are saved in tour folders." | A missing document blocks posting. |
| 42 | "Journal processing: Load tour related journals to Oracle." | Only the gateway posts journals. gram has no Oracle adapter; NetSuite is the closest. |
| 43 | "Audit preparation: Prepare end of tour audit checklists to ensure key tour documentation is held on file for audit purposes." | The end-of-tour checklist is generated from the work log, with "why?" per show. |
| 44 | "Compliance submissions: Prepare APRA/PPCA submissions for sign off." | One music-licence return per show, computed from box office, waiting for sign-off (section 7). |
| 45 | "Cash flow coordination: Liaise with the bank to arrange cash floats requested by Tour Accountants." | A float request is a work item a Tour Accountant raises and someone else approves. |
| 46 | "Process improvement: Actively review the settlement process to identify efficiencies and improvements." | Policy proposals drawn from precedents. |

## 2. The settlement owner: Settlement Manager, Live Nation Concerts (JR-93290)

[Job posting](https://livenation.wd503.myworkdayjobs.com/en-US/LNExternalSite/job/LN-Concerts--Settlement-Manager_JR-93290), extract `source-extracts/live-nation-settlement-manager.txt`, Philadelphia (line 12), "Posted 23 Days Ago" (line 18). This is a US role. Use it for what a settlement owner does, not as a fact about Australia.

| Line | Exact wording | What gram builds from it |
|---|---|---|
| 37 | "…owning the show documentation and financial completion of shows." | The person who owns each show's settlement. |
| 37 | "…record all revenue, expenses, payment advances, and monies due, as well as executing and/or receiving final payments for all." | The settlement sheet's sections: revenue, expenses, advances, monies due, final payment. |
| 37 | "…finalizing and uploading all itemized recaps and corresponding backup of the event's expenses and revenue. This role reports to the Regional Vice President of Finance." | A recap with backup for each show; the controller role. |
| 41 | "Conduct on site show settlements for high volume of shows in (clubs, theaters, amphitheaters & arenas, and festivals.)" | The venue types on the tour. |
| 43–45 | "Review Artist and building Venue contracts." "Compile show expenses from Production Manager, vendors, building, artist and marketing teams." "Work with accounting team to close out each show." | The sources that can disagree: contract, settlement sheet and deposit. |
| 55 | "Must be able to read and interpret ticket audits" | The ticket audit (box office report) is an input document. |

## 3. When revenue counts and whose money it is (2025 Form 10-K)

[Segments and revenue recognition note](https://investors.livenationentertainment.com/sec-filings/annual-reports/xbrl_doc_only/3470), extract `source-extracts/live-nation-revenue-recognition-2025.txt`. The whole note is on line 13; search for the quoted sentence.

- "Over 97% of Concerts’ revenue, whether related to promotion, venue operations, artist management or artist event merchandising, is recognized on the day of the related event." A show's revenue posts on the show date, not when the cash arrives.
- "Consideration received in advance of the event is recorded as deferred revenue or in long-term liabilities if the event is more than twelve months from the balance sheet date." Ticket cash received before the show sits in deferred revenue.
- "As a promoter and venue operator, we earn revenue primarily from the sale of tickets, concessions, merchandise, parking, ticket rebates or service charges on tickets sold by Ticketmaster or third-party ticketing platforms, and rental of our owned or operated venues." These are the settlement's revenue lines.
- "The Ticketing segment is primarily an agency business that sells tickets for events on behalf of its clients, which include venues, concert promoters, …" and "We do not record the face value of the tickets or the venue’s portion of the service fees as revenue." Face value that Ticketmaster collects is owed to the client; the seat must never book it as revenue.
- "A significant portion of our service charges are payable to the venue and credit card vendors." Fee splits appear on the settlement.
- "Ticketing contract advances, which can be either recoupable or non-recoupable, represent amounts paid in advance to our clients pursuant to ticketing agreements…" and "Recoupable ticketing contract advances are generally recoupable against future royalties earned by the client, based on the contract terms, over the life of the contract." An advance netted on a settlement is recoupment, not a short payment.
- "Revenue is recognized over the term of the agreement or operating season as the benefits are provided to the sponsor unless the revenue is associated with a specific event, in which case it is recognized when the event occurs." Sponsor money tied to a show is recognized on the show date.

## 4. Balance-sheet anchors (2025 Form 10-K)

[Consolidated balance sheet](https://investors.livenationentertainment.com/sec-filings/annual-reports/xbrl_doc_only/3453), extract `source-extracts/live-nation-balance-sheet-2025.txt`. Company-wide context only; there are no figures for individual shows.

| Line | Item | Dec 31, 2025 | Dec 31, 2024 |
|---|---|---:|---:|
| 12 | Cash and cash equivalents | $7,094,200,000 | $6,095,424,000 |
| 14 | Prepaid expenses | 1,453,732,000 | 1,247,184,000 |
| 23 | Long-term advances | 631,071,000 | 520,482,000 |
| 27 | Accounts payable, client accounts | 1,941,389,000 | 1,859,678,000 |
| 29 | Deferred revenue | 4,461,959,000 | 3,721,092,000 |

Line 59 defines client accounts payable as "obligations incurred and payable, due to ticketing clients, which includes the face value of tickets sold and the clients' share of convenience and order processing charges."

## 5. Live Nation's own cash versus other people's (2025 results release)

[Reconciliation of Free Cash to Cash and Cash Equivalents](https://news.livenationentertainment.com/news/live-nation-entertainment-full-year-and-fourth-quarter-2025-results), extract `source-extracts/live-nation-cash-reconciliation-2025.txt`, lines 11–18, $ millions:

| Cash and cash equivalents | Short-term investments | Client cash | Deferred revenue, event-related | Accrued artist fees | Collections on behalf of others | Prepaid expenses, event-related | Free cash |
|---:|---:|---:|---:|---:|---:|---:|---:|
| 7,094.2 | 76.5 | (1,621.6) | (3,982.5) | (225.4) | (143.1) | 797.7 | 1,995.8 |

"Free cash" is Live Nation's own non-GAAP measure, not a rule for what may be spent. The seat keeps these categories separate, so money in the bank is never treated as Live Nation's own just because it arrived.

## 6. Ticketmaster refund terms (US Standard Purchase Policy)

[Purchase policy](https://legal.ticketmaster.com/purchase-policy/), captured 2026-10-17, extract `architecture-synthesis-2026-10-17/rep-public-evidence/f05636.txt`.

| Line | Section | Exact wording |
|---|---|---|
| 256 | 14 | "Only the original purchaser of a ticket is eligible for refunds or credits—not the recipient of a transfer." |
| 284–286 | 15 | "If an event is canceled, no action is required to obtain a refund; we will issue a refund … to the original method of payment used at time of purchase after we receive funds from the Event Organizer." |
| 299–301 | 15 | For a postponed, rescheduled or moved event, tickets "are still valid", and "any refund and/or credit policies are determined on an event-by-event basis by the Event Organizer". |
| 312 | 15 | "If you don’t notify us that you are unable to attend within the applicable deadline, you will not be able to claim a refund." |
| 327 | 16 | "We will issue a refund of the ticket price you paid, any additional Extras or upgrades (such as parking), and (typically) service fees." |
| 328 | 16 | "We will not refund expedited shipping charges, merchandise purchases, Fan Club membership fees, or any other amounts." |
| 330 | 16 | "The refund will be processed to the original method of payment used at the time of purchase. We cannot issue a refund to a different method of payment…" |

Two cautions:

- This is the US policy. Fans in Australia and New Zealand buy under Ticketmaster's local terms, which we have not captured.
- It conflicts with gram's existing ticket rule. `readme.md:366` says refunds never return "the earned service fee", while section 16 says service fees are "(typically)" refunded.

Refunds wait until Ticketmaster has received funds from the event organizer (line 286), so a cancellation creates a cash dependency between the two businesses.

## 7. Music licence returns (APRA AMCOS and PPCA, through OneMusic Australia)

The duty is posting line 44: "Prepare APRA/PPCA submissions for sign off." Search summaries of OneMusic Australia's 2022 consultation papers report these rates for its Ticketed Music Events scheme:

- **APRA (musical works):** 2.2% of Gross Box Office Receipts. OneMusic said the APRA rates did not change under the new scheme.
- **Minimum fee:** $82.50 per event.
- **Eligible Temporary Music Events:** 1.65% of Net Box Office Receipts.
- **PPCA changeover tier** (recorded music only between live sets): $0.25 per attendee.
- **Effective date:** events from 1 November 2022 in one paper; OneMusic's announcement says 1 January 2023.

**Not verified.** On 2026-10-23, onemusic.com.au and apraamcos.com.au returned HTTP 403 to automated fetches. These figures come from search-result summaries of the papers, not from reading them. A search summary also mentions a review of the scheme from July 2024; no outcome was found. Before the seat cites a rate, a person should open the papers in a browser and confirm the 2026 rate and the definition of Gross Box Office Receipts. Until then, keep the rate a controller-set parameter that cites this section.

Sources: [Ticketed Music Events and Eligible Temporary Music Events](https://onemusic.com.au/media/consultation/Ticketed-Music-Events-Eligible-Temporary-Music-Events_221117.pdf), [Promoted Events and Eligible Outdoor Events](https://onemusic.com.au/media/consultation/Promoted-Events-and-Eligible-Outdoor-Events_220831.pdf), [OneMusic announces new Events scheme](https://onemusic.com.au/news/2022/september/onemusic-announces-new-events-scheme/).

## 8. GST

Australia 10% ([ATO](https://www.ato.gov.au/businesses-and-organisations/international-tax-for-business/in-detail/trans-tasman-rules/comparing-the-new-zealand-and-australian-tax-system/goods-and-services-tax)); New Zealand 15% ([Inland Revenue](https://www.ird.govt.nz/gst)). Both come from search-result summaries of the official pages, not from fetching them.

## 9. What no public source gives us

Simulate these, and label them as simulated in the data, the console and the readme:

- Each show's settlement sheet, the venue and artist deal terms, and what each venue contract lets the venue deduct.
- The bank deposits: amounts, dates, references, and how venues combine shows in one deposit.
- Live Nation's approval-limit amounts. JR-93271 says the limits exist, not how large they are.
- Live Nation Australasia's chart of accounts and its Oracle setup.
- Who the officer reports to in Australia. JR-93271 doesn't say.
- The past tours the seat learns from.
- Ticketmaster's Australian and New Zealand purchase terms.

A planted mistake must never be presented as something a real venue did.

## 10. Collected, but not for this seat

`live-nation-canvas-2026-10-20/findings.txt` (lines 38–59) and its `source-manifest.json` cover the June 2026 10-Q, the 30 April 2026 master trust indenture and its 8 May supplement, which sit behind the Fieldwork trust-transfer demo. They are context only:

- balance-sheet cash of $9.071949bn and current deferred revenue of $7.334511bn
- about $1.9bn of client cash inside cash and equivalents, and about $99.7m of restricted cash reported outside it (lines 45–47)
- the supplement's section 2.3 states EUR610m of proceeds, while its seven printed applications total EUR609.96m (lines 51–52)
