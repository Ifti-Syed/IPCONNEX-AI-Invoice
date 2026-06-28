from __future__ import unicode_literals

import frappe
import json
import base64
import os
import re
import mimetypes
import time

from frappe import _
from openai import OpenAI
from frappe.utils.file_manager import get_file_path

# Tolerance for sum(item.amount) vs printed subtotal/total check
_AMOUNT_TOLERANCE_PCT = 0.005   # 0.5%
_AMOUNT_TOLERANCE_ABS = 0.50    # absolute floor for tiny invoices


# ===================================================
# Helpers
# ===================================================

def get_openai_client(account_name):
    api_key = frappe.db.get_value("GPT Setting", account_name, "gpt_key")
    model = frappe.db.get_value("GPT Setting", account_name, "gpt_model")

    if not api_key or not model:
        frappe.throw(_("OpenAI API key or model not configured"))

    return OpenAI(api_key=api_key), model


def get_allowed_companies(doctype):
    return frappe.get_all(doctype, pluck="name")


def parse_and_clean_json(text):
    """Return dict or None."""
    if not text:
        return None

    cleaned = text.strip()

    # Remove markdown code fences if present
    cleaned = re.sub(r"^\s*```(?:json)?\s*", "", cleaned, flags=re.IGNORECASE)
    cleaned = re.sub(r"\s*```\s*$", "", cleaned)
    cleaned = cleaned.strip()

    try:
        return json.loads(cleaned)
    except Exception:
        pass

    match = re.search(r"\{.*\}", cleaned, re.DOTALL)
    if match:
        try:
            return json.loads(match.group())
        except Exception:
            return None

    return None


def _safe_float(v, default=0.0):
    try:
        if v is None or v == "":
            return float(default)
        # Remove thousand-separator commas (e.g. "1,234.56" → 1234.56)
        if isinstance(v, str):
            v = v.replace(",", "").strip()
        return float(v)
    except Exception:
        return float(default)


def _safe_str(v, default=""):
    if v is None:
        return default
    if isinstance(v, str):
        return v
    try:
        return str(v)
    except Exception:
        return default


def _amounts_match(computed, printed):
    """True if |computed - printed| is within tolerance."""
    if printed == 0:
        return abs(computed) <= _AMOUNT_TOLERANCE_ABS
    diff = abs(computed - printed)
    return diff <= max(_AMOUNT_TOLERANCE_ABS, abs(printed) * _AMOUNT_TOLERANCE_PCT)


def _fix_item_amount(item):
    """
    If amount is 0 but qty and rate are both non-zero, derive amount from qty × rate.
    This recovers items where the model forgot to fill the amount column.
    """
    qty = item["qty"]
    rate = item["rate"]
    amount = item["amount"]
    if amount == 0.0 and qty and rate:
        item["amount"] = round(qty * rate, 4)
    return item


def normalize_and_validate(payload, allowed_companies, default_company):
    """
    Ensure output matches required schema + types.
    Auto-correct company if not in whitelist.
    Auto-fix item amounts where possible.
    """
    if not isinstance(payload, dict):
        return None

    result = {
        "supplier": _safe_str(payload.get("supplier", "")),
        "company": _safe_str(payload.get("company", "")),
        "bill_no": _safe_str(payload.get("bill_no", "")),
        "bill_date": _safe_str(payload.get("bill_date", "")) or "YYYY-MM-DD",
        "currency": _safe_str(payload.get("currency", "")),
        "subtotal": _safe_float(payload.get("subtotal", 0.0)),
        "total_amount": _safe_float(payload.get("total_amount", 0.0)),
        "mode_of_payment": _safe_str(payload.get("mode_of_payment", "")),
        "paid_amount": _safe_float(payload.get("paid_amount", 0.0)),
        "items": payload.get("items", []),
        "taxes": payload.get("taxes", []),
    }

    if not isinstance(result["items"], list):
        result["items"] = []

    if not isinstance(result["taxes"], list):
        result["taxes"] = []

    norm_items = []
    for it in result["items"]:
        if not isinstance(it, dict):
            continue
        qty = _safe_float(it.get("qty", 1.0))
        item = {
            "item_code": _safe_str(it.get("item_code", "")),
            "item_name": _safe_str(it.get("item_name", "")),
            "qty": qty if qty else 1.0,
            "rate": _safe_float(it.get("rate", 0.0)),
            "amount": _safe_float(it.get("amount", 0.0)),
            "uom": _safe_str(it.get("uom", "")),
            "expense_account": _safe_str(it.get("expense_account", "")),
        }
        item = _fix_item_amount(item)
        norm_items.append(item)
    result["items"] = norm_items

    norm_taxes = []
    for tx in result["taxes"]:
        if not isinstance(tx, dict):
            continue
        norm_taxes.append({
            "description": _safe_str(tx.get("description", "")),
            "tax_amount": _safe_float(tx.get("tax_amount", 0.0)),
            "tax_currency": _safe_str(tx.get("tax_currency", "")),
        })
    result["taxes"] = norm_taxes

    if result["company"] not in allowed_companies:
        result["company"] = default_company

    required = ["supplier", "company", "bill_no", "bill_date", "items"]
    for k in required:
        if k not in result:
            return None

    return result


def _validate_items_sum(normalized):
    """
    Compare sum(item.amount) against the printed subtotal or total_amount.

    Returns:
      {
        "ok": bool,
        "items_sum": float,
        "expected": float,
        "expected_field": str,   # "subtotal" | "total_amount" | "none"
        "diff": float,
      }
    """
    items = normalized.get("items", [])
    items_sum = round(sum(it.get("amount", 0.0) for it in items), 4)

    subtotal = normalized.get("subtotal", 0.0)
    total = normalized.get("total_amount", 0.0)

    # Prefer subtotal (before tax); fall back to total_amount
    if subtotal and subtotal > 0:
        expected = subtotal
        field = "subtotal"
    elif total and total > 0:
        expected = total
        field = "total_amount"
    else:
        return {"ok": True, "items_sum": items_sum, "expected": 0.0, "expected_field": "none", "diff": 0.0}

    diff = abs(items_sum - expected)
    ok = _amounts_match(items_sum, expected)

    return {"ok": ok, "items_sum": items_sum, "expected": expected, "expected_field": field, "diff": diff}


def _build_correction_prompt(base_prompt, validation, normalized):
    """Build a targeted reprompt when items sum does not match subtotal/total."""
    items_sum = validation["items_sum"]
    expected = validation["expected"]
    field = validation["expected_field"]
    diff = validation["diff"]
    item_count = len(normalized.get("items", []))

    lines = [
        "YOUR PREVIOUS EXTRACTION CONTAINS AN ERROR — PLEASE FIX IT:",
        f"  • You extracted {item_count} line item(s) whose amounts sum to {items_sum:.4f}.",
        f"  • The invoice printed {field} is {expected:.4f}.",
        f"  • Discrepancy: {diff:.4f}.",
        "",
        "This means you either MISSED one or more line items, OR you assigned a price to the wrong column.",
        "",
        "CORRECTIVE INSTRUCTIONS:",
        "1. Re-scan the invoice table row by row. Count every product/service row.",
        "2. Each row must become its own entry in 'items' — do not skip any.",
        "3. Identify columns by their HEADER LABEL (Description, Qty, Unit Price, Amount).",
        "4. For every item verify: qty × rate ≈ amount (within rounding).",
        "5. After listing all items verify: sum(amount) ≈ printed subtotal.",
        "6. Return the COMPLETE corrected JSON — do NOT omit any items.",
        "",
        base_prompt,
    ]
    return "\n".join(lines)


def _extract_output_text_from_response(resp):
    """
    Robust extraction for Responses API:
    - Prefer output_text attribute if present.
    - Else concatenate output blocks of type output_text.
    """
    ot = getattr(resp, "output_text", None)
    if isinstance(ot, str) and ot.strip():
        return ot.strip()

    text_parts = []
    output = getattr(resp, "output", None)
    if isinstance(output, list):
        for item in output:
            if isinstance(item, dict) and item.get("type") == "output_text":
                t = item.get("text", "")
                if t:
                    text_parts.append(t)
    return ("\n".join(text_parts)).strip()


def _pdf_to_images_base64(full_path, max_pages=10, dpi=200):
    """
    Convert PDF pages to PNG bytes (base64 data URLs).
    Tries PyMuPDF first, then pdf2image as fallback.

    Returns: list[str] of data URLs — data:image/png;base64,...
    """
    try:
        import fitz  # PyMuPDF
        doc = fitz.open(full_path)
        page_count = min(len(doc), max_pages)

        data_urls = []
        zoom = dpi / 72.0
        mat = fitz.Matrix(zoom, zoom)

        for i in range(page_count):
            page = doc.load_page(i)
            pix = page.get_pixmap(matrix=mat, alpha=False)
            png_bytes = pix.tobytes("png")
            b64 = base64.b64encode(png_bytes).decode("utf-8")
            data_urls.append(f"data:image/png;base64,{b64}")
        doc.close()
        return data_urls

    except Exception:
        pass

    try:
        from pdf2image import convert_from_path
        images = convert_from_path(full_path, dpi=dpi, first_page=1, last_page=max_pages)
        data_urls = []
        for img in images:
            from io import BytesIO
            buf = BytesIO()
            img.save(buf, format="PNG")
            b64 = base64.b64encode(buf.getvalue()).decode("utf-8")
            data_urls.append(f"data:image/png;base64,{b64}")
        return data_urls
    except Exception as e:
        frappe.throw(_("PDF multi-page support requires PyMuPDF (fitz) or pdf2image. Error: {0}").format(str(e)))


def build_prompt(company_list, default_company):
    return f"""
CRITICAL INSTRUCTIONS:
1. YOU MUST OUTPUT A VALID JSON OBJECT AND NOTHING ELSE — NO MARKDOWN, NO CODE BLOCKS
2. DO NOT WRAP THE JSON IN ```json OR ANY OTHER FORMATTING
3. DO NOT INCLUDE ANY EXPLANATIONS, COMMENTS, OR EXTRA TEXT
4. ENSURE THE JSON IS PROPERLY FORMATTED AND CAN BE PARSED BY json.loads()
5. IF YOU CANNOT FIND A VALUE, USE THE DEFAULT VALUES SPECIFIED BELOW

You are an expert AI Invoice Extractor. Extract structured data from the provided invoice file and return it as a valid JSON object.

LANGUAGE RULES (IMPORTANT):
- Invoices may be in Arabic, English, or bilingual.
- DO NOT translate proper names: keep supplier and company names exactly as written (Arabic stays Arabic).
- Extract numbers exactly as shown.
- If labels are Arabic (e.g., رقم الفاتورة, تاريخ, المورد), map them to the same fields.
- Arabic invoices are read RIGHT-TO-LEFT: map columns by their HEADER LABEL, not their visual position.

STRICT EXTRACTION RULES:
1. OUTPUT FORMAT: Return ONLY a single valid JSON object. No additional text.
2. Company Name (company): MUST be exactly one of: {company_list}. If no match found, use "{default_company}".
3. Supplier Name (supplier): Extract the exact supplier name as it appears on the invoice (keep Arabic if Arabic).
4. Missing Values:
   - Strings: Use empty string ""
   - Integers: Use 0
   - Floats: Use 0.0
5. Date Format: Always use "YYYY-MM-DD" format for bill_date.
6. Currency: Extract currency information when available (AED, QAR, SAR, EUR, USD, etc.)
7. Arrays:
   - If no items found, use empty array: "items": []
   - For items: Extract quantity, unit price, amount, and unit of measure (UOM)
   - UOM: Look for abbreviations like "Ea", "Pcs", "Box", "Set", "Kg", "Ltr", "Meter". If no UOM is found, use "".
   - If no taxes found, use empty array: "taxes": []

LINE ITEM EXTRACTION RULES (CRITICAL — READ CAREFULLY):
1. EXTRACT EVERY SINGLE LINE ITEM — do not skip, summarize, or omit any row that represents a product or service.
2. NEVER merge or combine multiple line items into one, even if they have the same description or product name. Each row in the invoice table = one separate object in the "items" array.
3. If the invoice spans MULTIPLE PAGES, scan all pages and collect items from every page. Items often continue on page 2, 3, etc. — include all of them.
4. COLUMN MAPPING — identify table columns by their HEADER LABEL, not their visual left-to-right position:
   - Description / Item / Service / المادة / الوصف / البيان → item_name
   - Qty / Quantity / الكمية / العدد → qty
   - Unit Price / Rate / Price / سعر الوحدة / سعر الوحدة → rate
   - Amount / Total / Line Total / المبلغ / الإجمالي / المجموع → amount
   - UOM / Unit / وحدة القياس → uom
   - DO NOT guess column assignments from position alone. Always match by header label first.
5. SKIP these row types — they are NOT items:
   - Subtotal rows (e.g., "Subtotal", "Sub-Total", "المجموع الفرعي")
   - Total rows (e.g., "Total", "Grand Total", "الإجمالي")
   - Tax rows inside the item table (capture those in "taxes" array instead)
   - Section headers or category dividers
   - Empty rows or decorative lines
   - Notes, terms, or remarks rows
6. If a row has an amount but no separate qty and rate:
   - Set qty = 1.0
   - Set rate = the printed amount
   - Set amount = the printed amount
7. If a description wraps across two visual lines, treat them as ONE item — join the text.
8. Leave "item_code" and "expense_account" as "" for every item — do not guess these values.
9. NUMBERS: Remove thousand-separator commas before parsing (e.g. "1,234.56" → 1234.56).
10. SELF-VERIFICATION (perform this before outputting):
    a. Count every product/service row in the invoice table (excluding headers, subtotals, totals, tax rows). Your "items" array MUST have exactly that many entries.
    b. For each item, verify qty × rate ≈ amount (within rounding). If not, re-check which printed column you read for rate vs amount.
    c. Verify sum(item.amount) ≈ printed subtotal (before tax). If not, you have missed items — go back and re-scan all pages.

IMPORTANT:
- DO NOT CALCULATE totals or amounts. ONLY EXTRACT what is printed on the invoice.

REQUIRED JSON STRUCTURE (MUST MATCH EXACTLY):
{{
  "supplier": "",
  "company": "",
  "bill_no": "",
  "bill_date": "YYYY-MM-DD",
  "currency": "",
  "subtotal": 0.0,
  "total_amount": 0.0,
  "mode_of_payment": "",
  "paid_amount": 0.0,
  "items": [
    {{
      "item_code": "",
      "item_name": "First product or service description exactly as printed",
      "qty": 1.0,
      "rate": 100.0,
      "amount": 100.0,
      "uom": "",
      "expense_account": ""
    }},
    {{
      "item_code": "",
      "item_name": "Second product or service description exactly as printed",
      "qty": 2.0,
      "rate": 50.0,
      "amount": 100.0,
      "uom": "",
      "expense_account": ""
    }},
    {{
      "item_code": "",
      "item_name": "Third product — every row becomes its own object",
      "qty": 1.0,
      "rate": 200.0,
      "amount": 200.0,
      "uom": "",
      "expense_account": ""
    }}
  ],
  "taxes": [
    {{
      "description": "",
      "tax_amount": 0.0,
      "tax_currency": ""
    }}
  ]
}}

FIELD MAPPING:
- Map "Vendor", "Supplier", "From" and Arabic equivalents (e.g., المورد, البائع) to "supplier"
- Map "Customer", "Client", "Bill To" and Arabic equivalents (e.g., العميل, الفاتورة إلى) to "company"
- Map "Invoice Number", "Invoice ID", "Bill No" and Arabic equivalents (e.g., رقم الفاتورة) to "bill_no"
- Map "Invoice Date", "Date", "Bill Date" and Arabic equivalents (e.g., تاريخ الفاتورة, التاريخ) to "bill_date"
- Map "Payment Method", "Payment Type" and Arabic equivalents (e.g., طريقة الدفع) to "mode_of_payment"
- Map "Subtotal", "Sub-Total", "المجموع الفرعي" (the before-tax line total) to "subtotal"
- Map "Total", "Grand Total", "Amount Due", "Invoice Total" and Arabic equivalents (e.g., الإجمالي, المبلغ الإجمالي) to "total_amount"
- Map "Amount Paid", "Paid" and Arabic equivalents to "paid_amount" (0.0 if invoice is unpaid)
- For currency: Extract from printed amounts (e.g., QAR, AED, ر.ق, د.إ) or currency symbols and set in "currency" field (e.g. "AED", "QAR", "USD")
- For items: one JSON object per invoice table row — use item_name for the description exactly as printed
- For taxes: Extract tax descriptions (VAT, ضريبة القيمة المضافة, etc.) and amounts into the "taxes" array
""".strip()


def _make_messages(prompt, content_blocks):
    return [{
        "role": "user",
        "content": [{"type": "input_text", "text": prompt}] + content_blocks
    }]


def _log_debug(title, details):
    try:
        frappe.log_error(details, title)
    except Exception:
        pass


# ===================================================
# SITE UTILITIES
# ===================================================

@frappe.whitelist()
def getSiteName():
    try:
        site_name = frappe.local.site
        return json.dumps({"status": 1, "message": site_name})
    except Exception as e:
        return json.dumps({"status": 0, "message": str(e)})


# ===================================================
# MAIN METHOD (Frappe API)
# ===================================================

@frappe.whitelist()
def extract_invoice_with_vision(pdf_path, company_doctype, account_name):
    """
    Production-grade invoice extraction:
    - Multi-page PDF -> images -> vision
    - Safe output parsing
    - Retry logic with targeted correction on sum mismatch
    - Strong normalization & validation
    - Arabic-friendly prompt
    """

    try:
        client, model = get_openai_client(account_name)

        full_path = get_file_path(pdf_path)
        if not full_path or not os.path.exists(full_path):
            frappe.throw(_("Invoice file not found"))

        companies = get_allowed_companies(company_doctype)
        if not companies:
            frappe.throw(_("No companies found in the provided company doctype"))

        default_company = companies[0]
        company_list = ", ".join([f'"{c}"' for c in companies])
        prompt = build_prompt(company_list, default_company)

        ext = os.path.splitext(full_path)[1].lower()

        # -----------------------------------------------
        # Build content blocks
        # -----------------------------------------------
        content_blocks = []

        if ext in [".jpg", ".jpeg", ".png"]:
            mime = mimetypes.guess_type(full_path)[0] or "image/jpeg"
            with open(full_path, "rb") as f:
                b64 = base64.b64encode(f.read()).decode("utf-8")
            content_blocks.append({
                "type": "input_image",
                "image_url": f"data:{mime};base64,{b64}"
            })

        elif ext == ".pdf":
            max_pages = 10
            dpi = 200
            data_urls = _pdf_to_images_base64(full_path, max_pages=max_pages, dpi=dpi)
            for url in data_urls:
                content_blocks.append({
                    "type": "input_image",
                    "image_url": url
                })

        else:
            return {"status": 0, "error": f"Unsupported file type: {ext}"}

        # -----------------------------------------------
        # Retry + validation loop
        # -----------------------------------------------
        max_retries = 3
        last_error = ""
        active_prompt = prompt

        for attempt in range(1, max_retries + 1):
            try:
                messages = _make_messages(active_prompt, content_blocks)
                resp = client.responses.create(
                    model=model,
                    input=messages,
                    temperature=0
                )

                output_text = _extract_output_text_from_response(resp)
                last_output = output_text or ""

                _log_debug(
                    "Invoice Vision OCR Raw Output (truncated)",
                    f"Attempt: {attempt}\nModel: {model}\nOutput (first 4000 chars):\n{last_output[:4000]}"
                )

                parsed = parse_and_clean_json(output_text)
                if not parsed:
                    last_error = "Invalid JSON returned"
                    if attempt < max_retries:
                        active_prompt = (
                            "YOUR PREVIOUS OUTPUT WAS NOT VALID JSON. "
                            "Return ONLY ONE VALID JSON OBJECT that matches the required schema. "
                            "No markdown, no comments, no extra text.\n\n" + prompt
                        )
                        time.sleep(0.3)
                        continue
                    break

                normalized = normalize_and_validate(parsed, companies, default_company)
                if not normalized:
                    last_error = "Normalization/validation failed"
                    if attempt < max_retries:
                        active_prompt = (
                            "YOUR PREVIOUS JSON DID NOT MATCH THE REQUIRED SCHEMA/TYPES. "
                            "Return ONLY ONE VALID JSON OBJECT EXACTLY matching the schema.\n\n" + prompt
                        )
                        time.sleep(0.3)
                        continue
                    break

                # ── Items sum validation ──────────────────────────
                validation = _validate_items_sum(normalized)
                if not validation["ok"] and attempt < max_retries:
                    _log_debug(
                        "Invoice Sum Mismatch",
                        (
                            f"Attempt {attempt}: items_sum={validation['items_sum']}, "
                            f"expected={validation['expected']} ({validation['expected_field']}), "
                            f"diff={validation['diff']}"
                        )
                    )
                    active_prompt = _build_correction_prompt(prompt, validation, normalized)
                    time.sleep(0.3)
                    continue

                # ── Duplicate bill check ──────────────────────────
                duplicate_warning = None
                bill_no = normalized.get("bill_no", "")
                supplier = normalized.get("supplier", "")
                if bill_no and supplier:
                    existing = frappe.db.get_value(
                        "Purchase Invoice",
                        {"bill_no": bill_no, "supplier": supplier, "docstatus": ["!=", 2]},
                        ["name", "posting_date"],
                        as_dict=True
                    )
                    if existing:
                        duplicate_warning = _(
                            "Duplicate bill detected: Supplier Invoice No {0} for supplier {1} "
                            "already exists in Purchase Invoice {2} (Date: {3})."
                        ).format(bill_no, supplier, existing.name, existing.posting_date)

                result = {"status": 1, "data": normalized}
                if duplicate_warning:
                    result["duplicate_warning"] = duplicate_warning
                # Surface a warning if the final attempt still has a mismatch
                if not validation["ok"]:
                    result["sum_warning"] = (
                        f"Items sum ({validation['items_sum']:.2f}) does not match "
                        f"{validation['expected_field']} ({validation['expected']:.2f}). "
                        "Please review the extracted line items manually."
                    )
                return result

            except Exception as e:
                last_error = str(e)
                _log_debug("Invoice Vision OCR Attempt Error", f"Attempt: {attempt}\nError: {last_error}")
                if attempt < max_retries:
                    time.sleep(0.3)
                    continue

        frappe.throw(_("Invoice extraction failed after retries. Last error: {0}").format(last_error))

    except Exception as e:
        frappe.log_error(frappe.get_traceback(), "Invoice Vision OCR Error")
        return {"status": 0, "error": str(e)}
