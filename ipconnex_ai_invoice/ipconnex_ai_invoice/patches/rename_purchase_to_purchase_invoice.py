import frappe


def execute():
    """
    "Purchase" was renamed to "Purchase Invoice" as a Type option on
    Cvs Invoice Tool (to make room for a new "Purchase Receipt" option).
    Normalize any existing record still storing the old value so it keeps
    working exactly as before, without relying on a client-side fix.
    """
    if not frappe.db.exists("DocType", "Cvs Invoice Tool"):
        return

    frappe.db.set_value(
        "Cvs Invoice Tool",
        {"invoice_type": "Purchase"},
        "invoice_type",
        "Purchase Invoice",
        update_modified=False,
    )
