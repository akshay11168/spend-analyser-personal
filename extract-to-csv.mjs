#!/usr/bin/env node
/**
 * Extract Google Pay / My Activity HTML export entries into CSV.
 *
 * Usage:
 *   node extract-to-csv.mjs
 *   node extract-to-csv.mjs "My Activity2.html"
 *   node extract-to-csv.mjs "My Activity.html" activity.csv
 */

import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const inputPath = resolve(process.argv[2] ?? "My Activity2.html");
const outputPath = resolve(
  process.argv[3] ?? inputPath.replace(/\.html?$/i, "") + ".csv",
);

const HTML_ENTITIES = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  emsp: " ",
};

function decodeEntities(text) {
  return text
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) =>
      String.fromCharCode(parseInt(h, 16)),
    )
    .replace(/&([a-z]+);/gi, (match, name) => HTML_ENTITIES[name.toLowerCase()] ?? match);
}

function stripTags(html) {
  return decodeEntities(html.replace(/<[^>]+>/g, ""));
}

function cleanText(html) {
  return stripTags(html).replace(/\s+/g, " ").trim();
}

function splitLines(html) {
  return html
    .split(/<br\s*\/?>/i)
    .map((part) => cleanText(part))
    .filter(Boolean);
}

function csvEscape(value) {
  const s = value == null ? "" : String(value);
  if (/[",\r\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function parseDescription(description) {
  const result = {
    action: "",
    amount: "",
    currency: "",
    counterparty: "",
    payment_method: "",
  };

  const amountMatch = description.match(/([₹$€£])\s*([\d,]+(?:\.\d+)?)/);
  if (amountMatch) {
    result.currency = amountMatch[1] === "₹" ? "INR" : amountMatch[1];
    result.amount = amountMatch[2].replace(/,/g, "");
  }

  const paid = description.match(
    /^Paid\s+.+\s+to\s+(.+?)(?:\s+using\s+(.+))?$/i,
  );
  if (paid) {
    result.action = "Paid";
    result.counterparty = paid[1].trim();
    result.payment_method = (paid[2] ?? "").trim();
    return result;
  }

  const sentTo = description.match(
    /^Sent\s+.+\s+to\s+(.+?)(?:\s+using\s+(.+))?$/i,
  );
  if (sentTo) {
    result.action = "Sent";
    result.counterparty = sentTo[1].trim();
    result.payment_method = (sentTo[2] ?? "").trim();
    return result;
  }

  const sentUsing = description.match(/^Sent\s+.+\s+using\s+(.+)$/i);
  if (sentUsing) {
    result.action = "Sent";
    result.payment_method = sentUsing[1].trim();
    return result;
  }

  const received = description.match(/^Received\s+.+\s+from\s+(.+)$/i);
  if (received) {
    result.action = "Received";
    result.counterparty = received[1].trim();
    return result;
  }

  const requestedFromYou = description.match(
    /^(.+)\s+requested from you$/i,
  );
  if (requestedFromYou) {
    result.action = "Requested from you";
    return result;
  }

  const requested = description.match(/^Requested\b/i);
  if (requested) {
    result.action = "Requested";
    return result;
  }

  const firstWord = description.split(/\s+/)[0] ?? "";
  result.action = firstWord || "Other";
  return result;
}

function parseCaption(captionHtml) {
  const lines = splitLines(captionHtml);
  let product = "";
  let transactionId = "";
  let status = "";
  const details = [];
  let section = null;

  for (const line of lines) {
    if (/^Products:$/i.test(line)) {
      section = "products";
      continue;
    }
    if (/^Details:$/i.test(line)) {
      section = "details";
      continue;
    }
    if (/^Why is this here\?$/i.test(line)) {
      section = "why";
      continue;
    }

    if (section === "products" && !product) {
      product = line;
      continue;
    }

    if (section === "details") {
      if (/^(Completed|Failed|Pending|Cancelled|Declined)$/i.test(line)) {
        status = line;
      } else if (!transactionId && !/^From\b/i.test(line)) {
        // First details line is usually the opaque transaction id.
        transactionId = line;
      } else {
        details.push(line);
      }
      continue;
    }

    if (section === "why") {
      details.push(line);
    }
  }

  return { product, transactionId, status, details: details.join(" | ") };
}

function extractOuterCells(html) {
  const startRe =
    /<div class="outer-cell mdl-cell mdl-cell--12-col mdl-shadow--2dp">/g;
  const blocks = [];
  let startMatch;

  while ((startMatch = startRe.exec(html)) !== null) {
    const contentStart = startMatch.index + startMatch[0].length;
    let depth = 1;
    let i = contentStart;

    while (i < html.length && depth > 0) {
      const nextOpen = html.indexOf("<div", i);
      const nextClose = html.indexOf("</div>", i);
      if (nextClose === -1) break;

      if (nextOpen !== -1 && nextOpen < nextClose) {
        depth += 1;
        i = nextOpen + 4;
      } else {
        depth -= 1;
        if (depth === 0) {
          blocks.push(html.slice(contentStart, nextClose));
          break;
        }
        i = nextClose + 6;
      }
    }
  }

  return blocks;
}

function extractActivities(html) {
  const rows = [];

  for (const block of extractOuterCells(html)) {
    const headerMatch = block.match(
      /class="header-cell[^"]*"[\s\S]*?<p[^>]*>([\s\S]*?)<\/p>/i,
    );
    const header = headerMatch
      ? cleanText(headerMatch[1]).replace(/<br\s*\/?>/gi, "")
      : "";

    const bodyCells = [
      ...block.matchAll(
        /class="content-cell mdl-cell mdl-cell--6-col mdl-typography--body-1(?: mdl-typography--text-right)?"\s*>([\s\S]*?)<\/div>/gi,
      ),
    ].map((m) => m[1]);

    const leftHtml = bodyCells[0] ?? "";
    const rightHtml = bodyCells[1] ?? "";
    const leftLines = splitLines(leftHtml);
    const description = leftLines[0] ?? "";
    const datetime = leftLines[1] ?? "";
    const rightText = cleanText(rightHtml);

    const captionMatch = block.match(
      /class="content-cell mdl-cell mdl-cell--12-col mdl-typography--caption"\s*>([\s\S]*?)<\/div>/i,
    );
    const caption = parseCaption(captionMatch?.[1] ?? "");
    const parsed = parseDescription(description);

    rows.push({
      product: caption.product || header,
      action: parsed.action,
      description,
      amount: parsed.amount,
      currency: parsed.currency,
      counterparty: parsed.counterparty,
      payment_method: parsed.payment_method,
      datetime,
      status: caption.status,
      transaction_id: caption.transactionId,
      details: caption.details,
      extra: rightText,
    });
  }

  return rows;
}

const COLUMNS = [
  "product",
  "action",
  "description",
  "amount",
  "currency",
  "counterparty",
  "payment_method",
  "datetime",
  "status",
  "transaction_id",
  "details",
  "extra",
];

const html = readFileSync(inputPath, "utf8");
const rows = extractActivities(html);

const csv = [
  COLUMNS.join(","),
  ...rows.map((row) => COLUMNS.map((col) => csvEscape(row[col])).join(",")),
].join("\n");

writeFileSync(outputPath, csv + "\n", "utf8");

console.log(`Read:  ${inputPath}`);
console.log(`Wrote: ${outputPath}`);
console.log(`Rows:  ${rows.length}`);
if (rows.length) {
  console.log("Sample:");
  console.log(rows[0]);
}
