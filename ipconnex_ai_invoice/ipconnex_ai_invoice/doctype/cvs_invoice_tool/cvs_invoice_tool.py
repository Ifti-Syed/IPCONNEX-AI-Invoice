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
