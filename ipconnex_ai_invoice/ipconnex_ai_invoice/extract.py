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
    """Return dict or None"""
    if not text:
        return None

    cleaned = text.strip()

    # Remove markdown code fences if present
    cleaned = re.sub(r"^\s*```(?:json)?\s*", "", cleaned, flags=re.IGNORECASE)
    cleaned = re.sub(r"\s*```\s*$", "", cleaned)
    cleaned = cleaned.strip()

    # First try direct JSON
    try:
        return json.loads(cleaned)
    except Exception:
        pass

    # Try extracting the first JSON object found
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


def normalize_and_validate(payload, allowed_companies, default_company):
    """
    Ensure output matches required schema + types.
    Auto-correct company if not allowed.
    """
    if not isinstance(payload, dict):
        return None

    result = {
        "supplier": _safe_str(payload.get("supplier", "")),
        "company": _safe_str(payload.get("company", "")),
        "bill_no": _safe_str(payload.get("bill_no", "")),
        "bill_date": _safe_str(payload.get("bill_date", "")) or "YYYY-MM-DD",
        # keep these two since your standalone expects them sometimes
        "mode_of_payment": _safe_str(payload.get("mode_of_payment", "")),
        "paid_amount": _safe_float(payload.get("paid_amount", 0.0)),
        "items": payload.get("items", []),
        "taxes": payload.get("taxes", []),
    }

    # Items must be list
    if not isinstance(result["items"], list):
        result["items"] = []

    # Taxes must be list
    if not isinstance(result["taxes"], list):
        result["taxes"] = []

    # Normalize items entries
    norm_items = []
    for it in result["items"]:
        if not isinstance(it, dict):
            continue
        norm_items.append({
            "item_code": _safe_str(it.get("item_code", "")),
            "item_name": _safe_str(it.get("item_name", "")),
            "qty": _safe_float(it.get("qty", 0.0)),
            "rate": _safe_float(it.get("rate", 0.0)),
            "amount": _safe_float(it.get("amount", 0.0)),
            "uom": _safe_str(it.get("uom", "")),
            "expense_account": _safe_str(it.get("expense_account", "")),
        })
    result["items"] = norm_items

    # Normalize taxes entries
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

    # Enforce company whitelist
    if result["company"] not in allowed_companies:
        # Keep empty company? No, enforce default like your prompt
        result["company"] = default_company

    # Minimal required fields check
    required = ["supplier", "company", "bill_no", "bill_date", "items"]
    for k in required:
        if k not in result:
            return None

    return result


def _extract_output_text_from_response(resp):
    """
    Robust extraction for Responses API:
    - Prefer output_text if present
    - Else concatenate output blocks of type output_text
    """
    # Some SDK versions provide resp.output_text
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
    Tries PyMuPDF first, then pdf2image if available.

    Returns: list[str] of data URLs: data:image/png;base64,...
    """
    # Try PyMuPDF (fitz)
    try:
        import fitz  # PyMuPDF
        doc = fitz.open(full_path)
        page_count = min(len(doc), max_pages)

        data_urls = []
        zoom = dpi / 72.0  # fitz uses 72dpi baseline
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

    # Fallback: pdf2image
    try:
        from pdf2image import convert_from_path
        images = convert_from_path(full_path, dpi=dpi, first_page=1, last_page=max_pages)
        data_urls = []
        for img in images:
            # PIL Image -> bytes
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
1. YOU MUST OUTPUT A VALID JSON OBJECT AND NOTHING ELSE - NO MARKDOWN, NO CODE BLOCKS
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

IMPORTANT:
- DO NOT CALCULATE totals or amounts. ONLY EXTRACT what is printed on the invoice.

REQUIRED JSON STRUCTURE (MUST MATCH EXACTLY):
{{
  "supplier": "",
  "company": "",
  "bill_no": "",
  "bill_date": "YYYY-MM-DD",
  "mode_of_payment": "",
  "paid_amount": 0.0,
  "items": [
    {{
      "item_code": "",
      "item_name": "",
      "qty": 0.0,
      "rate": 0.0,
      "amount": 0.0,
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

EXTRACTION GUIDELINES:
- Map "Vendor", "Supplier", "From" and Arabic equivalents (e.g., المورد, البائع) to "supplier"
- Map "Customer", "Client", "Bill To" and Arabic equivalents (e.g., العميل, الفاتورة إلى) to "company"
- Map "Invoice Number", "Invoice ID", "Bill No" and Arabic equivalents (e.g., رقم الفاتورة) to "bill_no"
- Map "Invoice Date", "Date", "Bill Date" and Arabic equivalents (e.g., تاريخ الفاتورة, التاريخ) to "bill_date"
- Map "Payment Method", "Payment Type" and Arabic equivalents (e.g., طريقة الدفع) to "mode_of_payment"
- For currency: Extract from printed amounts (e.g., QAR, AED, ر.ق, د.إ) or currency symbols
- For items: Extract per line item (description, qty, rate, amount, uom)
- For taxes: Extract tax descriptions (VAT, ضريبة القيمة المضافة, etc.) and amounts
""".strip()


def _make_messages(prompt, content_blocks):
    """
    content_blocks: list of {"type": "input_image", ...} or {"type": "input_file", ...}
    """
    return [{
        "role": "user",
        "content": [{"type": "input_text", "text": prompt}] + content_blocks
    }]


def _log_debug(title, details):
    # Keep logs useful but not huge; tune as needed
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
    - Retry logic
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

        default_company = "Central Ventilation Systems Co. W.L.L. - Doha"
        company_list = ", ".join([f'"{c}"' for c in companies])
        prompt = build_prompt(company_list, default_company)

        ext = os.path.splitext(full_path)[1].lower()

        # -----------------------------------------------
        # Build content blocks
        # -----------------------------------------------
        content_blocks = []

        # Image types
        if ext in [".jpg", ".jpeg", ".png"]:
            mime = mimetypes.guess_type(full_path)[0] or "image/jpeg"
            with open(full_path, "rb") as f:
                b64 = base64.b64encode(f.read()).decode("utf-8")
            content_blocks.append({
                "type": "input_image",
                "image_url": f"data:{mime};base64,{b64}"
            })

        # PDFs -> multi-page images (recommended for production)
        elif ext == ".pdf":
            # Tune these for your environment
            max_pages = 10   # production default
            dpi = 200        # balance accuracy vs payload size

            data_urls = _pdf_to_images_base64(full_path, max_pages=max_pages, dpi=dpi)
            for url in data_urls:
                content_blocks.append({
                    "type": "input_image",
                    "image_url": url
                })

        else:
            return {
               "status": 0,
               "error": f"Unsupported file type: {ext}"
           }


        messages = _make_messages(prompt, content_blocks)

        # -----------------------------------------------
        # Retry logic
        # -----------------------------------------------
        max_retries = 3
        last_output = ""
        last_error = ""

        for attempt in range(1, max_retries + 1):
            try:
                resp = client.responses.create(
                    model=model,
                    input=messages,
                    temperature=0
                )

                output_text = _extract_output_text_from_response(resp)
                last_output = output_text or ""

                # Log raw output safely (truncate)
                _log_debug(
                    "Invoice Vision OCR Raw Output (truncated)",
                    f"Attempt: {attempt}\nModel: {model}\nOutput (first 4000 chars):\n{last_output[:4000]}"
                )

                parsed = parse_and_clean_json(output_text)
                if not parsed:
                    # Reprompt on next attempt with explicit correction instruction
                    last_error = "Invalid JSON returned"
                    if attempt < max_retries:
                        fix_prompt = (
                            "YOUR PREVIOUS OUTPUT WAS NOT VALID JSON. "
                            "Return ONLY ONE VALID JSON OBJECT that matches the required schema. "
                            "No markdown, no comments, no extra text."
                        )
                        messages = [{
                            "role": "user",
                            "content": [
                                {"type": "input_text", "text": fix_prompt + "\n\n" + prompt}
                            ] + content_blocks
                        }]
                        # small backoff
                        time.sleep(0.3)
                        continue
                    break

                normalized = normalize_and_validate(parsed, companies, default_company)
                if not normalized:
                    last_error = "Normalization/validation failed"
                    if attempt < max_retries:
                        fix_prompt = (
                            "YOUR PREVIOUS JSON DID NOT MATCH THE REQUIRED SCHEMA/TYPES. "
                            "Return ONLY ONE VALID JSON OBJECT EXACTLY matching the schema."
                        )
                        messages = [{
                            "role": "user",
                            "content": [
                                {"type": "input_text", "text": fix_prompt + "\n\n" + prompt}
                            ] + content_blocks
                        }]
                        time.sleep(0.3)
                        continue
                    break

                # Success — check for duplicate bill
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
                return result

            except Exception as e:
                last_error = str(e)
                _log_debug("Invoice Vision OCR Attempt Error", f"Attempt: {attempt}\nError: {last_error}")
                if attempt < max_retries:
                    time.sleep(0.3)
                    continue

        # If we exit retries
        frappe.throw(_("Invoice extraction failed after retries. Last error: {0}").format(last_error))


    except Exception as e:
        frappe.log_error(frappe.get_traceback(), "Invoice Vision OCR Error")
        return {"status": 0, "error": str(e)}
