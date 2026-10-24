# Live Nation sources for the Settlement Manager seat

These are the facts the seat's company data, policies and answer keys may cite, quoted from the real public documents the team collected. Anything not listed here is simulated and must be labeled as simulated (section 9).

Paths are relative to the team's research folder, `$R/hyphenate/research/`. `$R` is `~/Documents/calhacks/calhacks_extracted/calhacks` where `calhacks.tar.xz` was extracted, or `~/Code/hackathons/calhacks` in the original checkout. That folder is not in this repo. Line numbers refer to its files. Documents fetched on 2026-10-24 for the US move are quoted inline.

## 0. The company: Live Nation Concerts, a division of Live Nation Entertainment

[2025 Form 10-K](https://www.sec.gov/Archives/edgar/data/1335258/000133525826000009/lyv-20251231.htm), Item 1 and Item 2, read 2026-10-24:

- "Our principal executive offices are located at 9348 Civic Center Drive, Beverly Hills, California 90210".
- "We believe that we are one of the largest music festival producers in the world with 131 festivals globally in 2025."
- "connecting 159 million fans to over 11,000 artists at 55,000 events in 2025."
- "Live Nation owns, operates, has exclusive booking rights for or has an equity interest in 460 venues globally".
- "our festivals primarily occur, during May through October."
- The 10-K names no festival but Astroworld (in its legal proceedings). The festivals below come from the company's other statements.

[2025 full-year results release](https://news.livenationentertainment.com/news/live-nation-entertainment-full-year-and-fourth-quarter-2025-results), extract `source-extracts/live-nation-annual-results-2025.txt`, line 52: "Early indicators point to strong festival demand, with Electric Daisy Carnival sold out and ticket sales for Austin City Limits, Reading, and Leeds up double-digits". Electric Daisy Carnival is held in Las Vegas and Austin City Limits in Austin.

The seat's own posting (section 1) describes the division: "Live Nation Concerts is the largest provider of live entertainment in the world promoting more than 50,000 events annually for nearly 7,000 artists in 40+ countries."

Press reports, not company filings: Live Nation acquired a controlling stake in C3 Presents, the Austin producer of Lollapalooza (Chicago) and Austin City Limits, in 2014 ([Music Business Worldwide](https://www.musicbusinessworldwide.com/live-nation-takes-control-of-lollapaloozas-c3-presents/)), and a controlling interest in Bonnaroo in 2015 ([Digital Music News](https://www.digitalmusicnews.com/2015/04/28/live-nation-acquires-bonnaroo-may-large-indie-festivals-rest-in-peace/)). The company profile cites these as press reports.

What gram builds from this: the company is Live Nation Concerts; its books are in USD; three of the planted tour's cities (Chicago, Austin, Las Vegas) are the company's own festival cities, but the shows are arena dates at simulated venue partners, never festival dates, and nothing in the data is a statement about any festival's finances.

## 1. The seat: LN Concerts, Settlement Manager, Philadelphia (JR-93290)

[Job posting](https://livenation.wd503.myworkdayjobs.com/en-US/LNExternalSite/job/LN-Concerts--Settlement-Manager_JR-93290), extract `source-extracts/live-nation-settlement-manager.txt`, fetched 2026-10-16 ("Posted 23 Days Ago", line 18). Re-checked through Workday's job API on 2026-10-24: still open, location "Philadelphia, PA, USA", start date 2026-09-23.

| Line | Exact wording | What gram builds from it |
|---|---|---|
| 12 | "Philadelphia, PA, USA" | The seat sits in LN Concerts' touring finance in Philadelphia; the company is Live Nation Concerts. |
| 37 | "…owning the show documentation and financial completion of shows." | The seat owns each show's settlement record from the venue's deposit to the journal. |
| 37 | "…record all revenue, expenses, payment advances, and monies due, as well as executing and/or receiving final payments for all." | The settlement sheet's sections: revenue, expenses, advances, monies due. gram fills the recording side; executing payments stays with people, and the seat cannot move money. |
| 37 | "…finalizing and uploading all itemized recaps and corresponding backup of the event's expenses and revenue. This role reports to the Regional Vice President of Finance." | A recap with backup for each show; the controller role is the Regional VP of Finance. |
| 41 | "Conduct on site show settlements for high volume of shows in (clubs, theaters, amphitheaters & arenas, and festivals.)" | The venue types on the tour. On-site settlement is a person's work. |
| 43–45 | "Review Artist and building Venue contracts." "Compile show expenses from Production Manager, vendors, building, artist and marketing teams." "Work with accounting team to close out each show." | The sources that can disagree: contract, settlement sheet and deposit. Each tour invoice from production, vendors, the building and marketing becomes a work item. |
| 55 | "Must be able to read and interpret ticket audits" | The ticket audit (box office report) is an input document, and the gross. |

## 2. The control in Live Nation's own words: Tour Settlements Officer, Live Nation Australasia (JR-93271)

[Job posting](https://livenation.wd503.myworkdayjobs.com/en-US/LNExternalSite/job/Tour-Settlements-Officer_JR-93271), extract `source-extracts/live-nation-tour-settlements-officer.txt`, fetched 2026-10-16. This is a Melbourne role. Use it for how Live Nation describes the settlement function and its controls, not as a fact about the US company.

| Line | Exact wording | What gram builds from it |
|---|---|---|
| 39 | "Settlement accuracy: Ensure correct GL coding and cash receipting of venue settlements." | Each proposal carries a GL account; policies learn the coding from past tours. |
| 40 | "Invoice compliance: Check invoice operational approvals are compliant with approval limits before approving in the invoice workflow platform." | Approval limits enforced in code; whoever proposes cannot approve. The limit amounts are not public (section 9). |
| 41 | "Documentation management: Ensure all event related invoices are saved in tour folders." | A missing document blocks posting. |
| 43 | "Audit preparation: Prepare end of tour audit checklists to ensure key tour documentation is held on file for audit purposes." | The end-of-tour checklist is generated from the work log, with "why?" per show. |

Not used: the APRA/PPCA submissions (line 44) are an Australian music-licence duty; the US equivalent is section 7. The cash floats (line 45) and Oracle (line 42) are not asserted about the US company.

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

[Purchase policy](https://legal.ticketmaster.com/purchase-policy/), captured 2026-10-17, extract `architecture-synthesis-2026-10-17/rep-public-evidence/f05636.txt`. This is the policy fans in the United States buy under, so it is the right jurisdiction for the US shows; Canadian fans buy under Ticketmaster Canada's terms, which we have not captured.

| Line | Section | Exact wording |
|---|---|---|
| 256 | 14 | "Only the original purchaser of a ticket is eligible for refunds or credits—not the recipient of a transfer." |
| 284–286 | 15 | "If an event is canceled, no action is required to obtain a refund; we will issue a refund … to the original method of payment used at time of purchase after we receive funds from the Event Organizer." |
| 299–301 | 15 | For a postponed, rescheduled or moved event, tickets "are still valid", and "any refund and/or credit policies are determined on an event-by-event basis by the Event Organizer". |
| 312 | 15 | "If you don’t notify us that you are unable to attend within the applicable deadline, you will not be able to claim a refund." |
| 327 | 16 | "We will issue a refund of the ticket price you paid, any additional Extras or upgrades (such as parking), and (typically) service fees." |
| 328 | 16 | "We will not refund expedited shipping charges, merchandise purchases, Fan Club membership fees, or any other amounts." |
| 330 | 16 | "The refund will be processed to the original method of payment used at the time of purchase. We cannot issue a refund to a different method of payment…" |

One caution: it conflicts with gram's older ticket rule in the readme, which says refunds never return "the earned service fee", while section 16 says service fees are "(typically)" refunded.

Refunds wait until Ticketmaster has received funds from the event organizer (line 286), so a cancellation creates a cash dependency between the two businesses.

## 7. Performing-rights fees (BMI, ASCAP)

In the United States the songwriters' societies license concerts to the promoter (BMI through the promoters' association) and to venues and festivals (ASCAP's event license). The seat codes the performing-rights line a venue deducts on its statement from a controller-set parameter that cites these sources.

**BMI rate court, primary source.** *Broadcast Music, Inc. v. North American Concert Promoters Association*, No. 18 Civ. 8749 (LLS), United States District Court, Southern District of New York, Document 212, filed 03/28/23 ([PDF](https://www.digitalmusicnews.com/wp-content/uploads/2023/03/BMI-v-NA-concert-promoters-live-nation-mar-2023.pdf), read 2026-10-24):

- "BMI petitioned this Court to determine the reasonable rate that the North American Concert Promoters Association ("NACPA") owes for its members' right to perform BMI-affiliated music at live concerts."
- "the other that controls the "Current Period" running from July 1, 2018 through December 31, 2022."
- "For the Current Period, the reasonable rate is set at 0.5% of Gross Ticket Revenues, as defined below."
- "NACPA has forty-six concert-promoter members. Of those members, the most notable are Live Nation Entertainment, Inc. ("Live Nation") and AEG Presents, LLC ("AEG"). Live Nation is affiliated with approximately half of NACPA's other members".
- The 1998 license carried "a rate of 0.3% of "Gross Ticket Revenues" for concerts with under 10,000 seats and a rate of 0.15% for those with over 10,000 seats."
- BMI's proposed base for the Current Period (0.8%, which the court did not adopt) listed primary ticket sales, service and handling charges paid to the promoter, VIP packages and box suites, sponsorships and advertising, and direct-to-secondary-market sales; the court set the rate on the gross ticket revenues it defines.

**ASCAP 2026 festival and event rate schedule, primary source.** [Exhibit A, 2026 Rate Schedule](https://www.ascap.com/~/media/files/pdf/licensing/classes/2022-onwards-rates-reports-forms/genfest-rate.pdf), read 2026-10-24: "For Ticketed Events - 0.3% of Net Revenue"; "For Free Events – 1.5% of Entertainment Expense"; "2026 MINIMUM FEE: $310.00". Net Revenue is gross revenue less "amounts actually paid … to a Federal, state or local taxing authority for any applicable entertainment, amusement, or sales taxes or similar levies on the sale or license of Tickets", amounts paid to a third-party ticket distributor, per-ticket facility charges, parking, and the value of food and drink included in a ticket.

**What is and is not verified.** The BMI rate is a court-set rate on the promoter's blanket license for July 2018 to December 2022; the rate after 2022, Live Nation's own license terms, and the concert rates of ASCAP, SESAC and GMR are not captured. Whether a given venue charges its performing-rights costs back on a settlement is a term of the venue contract, which is simulated. The parameter is therefore 0.5% of gross, cited to the BMI decision, and stays a controller-set parameter until a person confirms the company's own rate.

## 8. Taxes on tickets (cited, not modeled)

Ticket prices in these cities include an admission or sales tax that the venue or ticketer remits; it is never box office. The fixtures state every ticket audit gross net of these taxes, so no settlement line codes them.

- **Philadelphia amusement tax, 5%.** [City of Philadelphia](https://www.phila.gov/services/payments-assistance-taxes/business-taxes/amusement-tax/), read 2026-10-24: "Amusement Tax is imposed at the rate of 5% of the admission charge for the amusement venue or event."; "Amusements include any concerts, movies, athletic contests, night clubs, and convention shows"; collected by anyone who will "Operate or provide any amusement in Philadelphia" or "Promote any show located in Philadelphia."; a temporary event "must both file and pay the tax within five days after the event is held."
- **Nevada live entertainment tax, 9%.** [Nevada Department of Taxation](https://tax.nv.gov/tax-types/live-entertainment-tax/), read 2026-10-24: "A 9 percent tax rate is imposed on the admission charge to a facility with a minimum occupancy of 200"; administered by "the Gaming Control Board for live entertainment events held within licensed gaming establishments" and "the Department of Taxation for live entertainment events held in other venues." Statute: [NRS 368A.200](https://nevada.public.law/statutes/nrs_368a.200).
- **Ontario HST, 13%** (the Toronto show). [Canada Revenue Agency, which rate to charge](https://www.canada.ca/en/revenue-agency/services/tax/businesses/topics/gst-hst-businesses/charge-collect-which-rate.html), read 2026-10-24, gives Ontario's rate by example: "The furniture store charges 13% HST on the sale because the place of supply is Ontario." That admissions to an event in Ontario are taxable comes from a search summary of CRA info sheet GI-058, which returned 404 to a fetch; not verified.
- **Chicago amusement tax, 9%** on in-person live events: from search summaries only (the city's page returned HTTP 403 to automated fetches on 2026-10-24); unverified, and Cook County adds its own. Chicago is on the tour; its ticket audit is stated net of tax like the others.

## 9. What no public source gives us

Simulate these, and label them as simulated in the data, the console and the readme:

- Each show's settlement sheet, the venue and artist deal terms, and what each venue contract lets the venue deduct, including whether it charges performing-rights costs back.
- The bank deposits: amounts, dates, references, and how venues combine shows in one deposit.
- Live Nation's approval-limit amounts. JR-93271 says the limits exist, not how large they are; JR-93290 says show expenses are compiled from production, vendors, the building and marketing.
- LN Concerts' chart of accounts and its ledger. NetSuite stands in; the US ledger is not public (Oracle is named only in the Australian posting).
- Who sits between the seat and the Regional Vice President of Finance. JR-93290 names only the reporting line.
- The past tours the seat learns from, and the USD-per-CAD book rate (0.73, a fixture).
- Ticketmaster Canada's purchase terms.

A planted mistake must never be presented as something a real venue, festival or city did.

## 10. Collected, but not for this seat

`live-nation-canvas-2026-10-20/findings.txt` (lines 38–59) and its `source-manifest.json` cover the June 2026 10-Q, the 30 April 2026 master trust indenture and its 8 May supplement, which sit behind the Fieldwork trust-transfer demo. They are context only:

- balance-sheet cash of $9.071949bn and current deferred revenue of $7.334511bn
- about $1.9bn of client cash inside cash and equivalents, and about $99.7m of restricted cash reported outside it (lines 45–47)
- the supplement's section 2.3 states EUR610m of proceeds, while its seven printed applications total EUR609.96m (lines 51–52)

OneMusic Australia's APRA/PPCA event rates, collected for the Australian version of this seat, are no longer cited anywhere; the Australian posting remains in section 2 for its wording of the controls.
