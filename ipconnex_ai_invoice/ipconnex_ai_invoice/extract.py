from __future__ import unicode_literals

import frappe
import json
import base64
import os
import re

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
    """
    Ensures we always return valid JSON or None
    """
    if not text:
        return None

    text = text.strip()

    # Remove markdown blocks if any
    text = re.sub(r"^```(json)?", "", text)
    text = re.sub(r"```$", "", text)

    text = text.strip()

    try:
        return json.loads(text)
    except json.JSONDecodeError:
        match = re.search(r"\{.*\}", text, re.DOTALL)
        if match:
            try:
                return json.loads(match.group())
            except Exception:
                return None
    return None


# ===================================================
# MAIN METHOD (Frappe API)
# ===================================================

@frappe.whitelist()
def extract_invoice_with_vision(pdf_path, company_doctype, account_name):
    """
    Extract invoice data using OpenAI Vision (PDF or Image)
    """

    try:
        # -----------------------------------------------
        # OpenAI client
        # -----------------------------------------------
        client, model = get_openai_client(account_name)

        # -----------------------------------------------
        # Resolve file path safely
        # -----------------------------------------------
        full_path = get_file_path(pdf_path)
        if not full_path or not os.path.exists(full_path):
            frappe.throw(_("Invoice file not found"))

        # -----------------------------------------------
        # Allowed companies
        # -----------------------------------------------
        companies = get_allowed_companies(company_doctype)
        company_list = ", ".join([f'"{c}"' for c in companies])

        # -----------------------------------------------
        # Prompt
        # -----------------------------------------------
        prompt = f"""
       CRITICAL INSTRUCTIONS:
       1. YOU MUST OUTPUT A VALID JSON OBJECT AND NOTHING ELSE - NO MARKDOWN, NO CODE BLOCKS
       2. DO NOT WRAP THE JSON IN ```json OR ANY OTHER FORMATTING
       3. DO NOT INCLUDE ANY EXPLANATIONS, COMMENTS, OR EXTRA TEXT
       4. ENSURE THE JSON IS PROPERLY FORMATTED AND CAN BE PARSED BY json.loads()
       5. IF YOU CANNOT FIND A VALUE, USE THE DEFAULT VALUES SPECIFIED BELOW

       You are an expert AI Invoice Extractor. Extract structured data from the provided invoice file and return it as a valid JSON object.

       ### STRICT EXTRACTION RULES:
       1. **OUTPUT FORMAT**: Return ONLY a single valid JSON object. No additional text.
       2. **Company Name (company)**: MUST be exactly one of: {company_list}. If no match found, use "Central Ventilation Systems Co. W.L.L. - Doha".
       3. **Supplier Name (supplier)**: Extract the exact supplier name as it appears on the invoice.
       4. **Missing Values**: 
          - Strings: Use empty string "" 
          - Integers: Use 0 
          - Floats: Use 0.0
       5. **Date Format**: Always use "YYYY-MM-DD" format for bill_date.
       6. **Currency**: Extract currency information when available (AED, QAR, SAR, EUR, etc.)
       7. **Arrays**: 
          - If no items found, use empty array: "items": []
          - For items: Extract quantity, unit price, amount, and unit of measure (UOM)
          - **Unit of Measure (UOM)**: Look for abbreviations like "Ea", "Pcs", "Box", "Set", "Kg", "Ltr", "Meter". If no UOM is found, use an empty string "".
          - If no taxes found, use empty array: "taxes": []

       ### REQUIRED JSON STRUCTURE - YOU MUST FOLLOW THIS EXACT FORMAT (MATCHES AZURE OUTPUT):
       {{
           "supplier": "",
           "company": "",
           "bill_no": "",
           "bill_date": "YYYY-MM-DD",
           "is_paid": 1,
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

       ### EXTRACTION GUIDELINES:
       - Map "Vendor", "Supplier", "From" fields to "supplier",usually supplier name is company name which will be top if the invoice heading
       - Map "Customer", "Client", "Bill To" fields to "company" 
       - Map "Invoice Number", "Invoice ID", "Bill No" to "bill_no"
       - Map "Invoice Date", "Date", "Bill Date" to "bill_date"
       - Map "Payment Method", "Payment Type" to "mode_of_payment"
       - For currency: Extract from amounts like "USD", "AED", "EUR" or currency symbols
       - For items: Extract quantity, unit price, amount, and unit of measure
       - For taxes: Extract tax descriptions (VAT, Sales Tax, etc.) and amounts
       """

        # -----------------------------------------------
        # File handling (IMAGE vs PDF)
        # -----------------------------------------------
        ext = os.path.splitext(full_path)[1].lower()

        if ext in [".jpg", ".jpeg", ".png"]:
            with open(full_path, "rb") as f:
                image_b64 = base64.b64encode(f.read()).decode()

            file_content = {
                "type": "input_image",
                "image_url": f"data:image/jpeg;base64,{image_b64}"
            }

        else:
            with open(full_path, "rb") as f:
                uploaded = client.files.create(
                    file=f,
                    purpose="user_data"
                )

            file_content = {
                "type": "input_file",
                "file_id": uploaded.id
            }

        # -----------------------------------------------
        # OpenAI API call
        # -----------------------------------------------
        response = client.responses.create(
            model=model,
            input=[
                {
                    "role": "user",
                    "content": [
                        {"type": "input_text", "text": prompt},
                        file_content
                    ]
                }
            ],
            temperature=0
        )

        output_text = response.output_text
        parsed = parse_and_clean_json(output_text)

        if not parsed:
            frappe.throw(_("AI did not return valid JSON"))

        if not isinstance(parsed.get("items"), list):
            frappe.throw(_("Invalid items structure in extracted data"))

        return {
            "status": 1,
            "data": parsed
        }

    except Exception as e:
        frappe.log_error(
            frappe.get_traceback(),
            "Invoice Vision OCR Error"
        )
        return {
            "status": 0,
            "error": str(e)
        }


