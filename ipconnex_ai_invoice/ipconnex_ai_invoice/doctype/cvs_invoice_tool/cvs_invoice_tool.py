from __future__ import unicode_literals
import frappe
from frappe.model.document import Document
from frappe import _

class CvsInvoiceTool(Document):
    pass


@frappe.whitelist()
def get_expense_account(item_code=None, company=None):
    """
    Resolve the default Expense Account for an Item, reusing ERPNext's own
    fallback chain: Item defaults (for company) -> Item Group defaults
    (for company) -> Company's default Expense Account.
    Never hardcodes an account.
    """
    if not company:
        return {"expense_account": ""}

    account = None

    if item_code:
        account = frappe.db.get_value(
            "Item Default",
            {"parent": item_code, "parenttype": "Item", "company": company},
            "expense_account",
        )
        if not account:
            item_group = frappe.db.get_value("Item", item_code, "item_group")
            if item_group:
                account = frappe.db.get_value(
                    "Item Default",
                    {"parent": item_group, "parenttype": "Item Group", "company": company},
                    "expense_account",
                )

    if not account:
        account = frappe.db.get_value("Company", company, "default_expense_account")

    return {"expense_account": account or ""}


@frappe.whitelist()
@frappe.validate_and_sanitize_search_inputs
def get_mode_of_payment_query(doctype, txt, searchfield, start, page_len, filters):
    """
    Link-field query for Mode of Payment: only lists modes that have a
    Mode of Payment Account row configured for the given company, so the
    dropdown never offers a mode that Cash/Bank Account auto-fill can't
    resolve for that company.
    """
    company = filters.get("company") if filters else None

    return frappe.db.sql(
        """
        select distinct mop.name
        from `tabMode of Payment` mop
        inner join `tabMode of Payment Account` mopa
            on mopa.parent = mop.name and mopa.parenttype = 'Mode of Payment'
        where mopa.company = %(company)s and mop.name like %(txt)s
        order by mop.name
        limit %(page_len)s offset %(start)s
        """,
        {
            "company": company,
            "start": start,
            "page_len": page_len,
            "txt": "%%%s%%" % txt,
        },
    )


@frappe.whitelist()
def is_mode_of_payment_valid_for_company(mode_of_payment=None, company=None):
    """
    Whether the given Mode of Payment has a Mode of Payment Account row
    configured for the given company (i.e. still valid after a Company
    change on the form).
    """
    if not mode_of_payment or not company:
        return {"valid": False}

    exists = frappe.db.exists(
        "Mode of Payment Account",
        {
            "parent": mode_of_payment,
            "parenttype": "Mode of Payment",
            "company": company,
        },
    )
    return {"valid": bool(exists)}


@frappe.whitelist()
def get_default_tax_account(company=None):
    """
    Best-effort default Account Head for a tax line, reusing the company's
    default Purchase Taxes and Charges Template (if configured in ERPNext).
    Returns blank when nothing is configured — never hardcodes an account.
    """
    if not company:
        return {"account_head": ""}

    template = frappe.db.get_value(
        "Purchase Taxes and Charges Template",
        {"company": company, "is_default": 1, "disabled": 0},
        "name",
    )
    if not template:
        return {"account_head": ""}

    account_head = frappe.db.get_value(
        "Purchase Taxes and Charges",
        {"parent": template, "parenttype": "Purchase Taxes and Charges Template"},
        "account_head",
    )
    return {"account_head": account_head or ""}
