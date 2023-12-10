
from __future__ import unicode_literals
import frappe
import json
from six import string_types
from frappe import _
from frappe.utils import flt
import stripe
import random
import time
@frappe.whitelist()
def createTaxes(taxes_account,company):#
    try:
        accounts_data=frappe.get_all("Account",
            filters = {
                "company":company,
                "account_type": "Tax",
            },
            fields=["account_name","name"])
        qst_name=""
        gst_name=""
        for line in accounts_data:
            if(line["account_name"]=="QST 9.975%"):
                qst_name=line["name"]
            if(line["account_name"]=="GST 5%"):
                gst_name=line["name"]
        if(qst_name==""):
            #insert qst
            qst=frappe.client.insert(doc={
                "doctype": "Account",
                "docstatus": 0,
                "idx": 0,
                "disabled": 0,
                "account_name": "QST 9.975%",
                "is_group": 0,
                "company": company,
                "root_type": "Liability",
                "report_type": "Balance Sheet",
                "account_currency": "CAD",
                "parent_account":taxes_account,
                "account_type": "Tax",
                "tax_rate": "9.975",
                "freeze_account": "No",
                "balance_must_be": "",
                "old_parent":taxes_account,
                "include_in_gross": 0,
                })
            qst_name=qst["name"]

        if(gst_name==""):
            #insert gst
            gst=frappe.client.insert(doc={
                "doctype": "Account",
                "docstatus": 0,
                "idx": 0,
                "disabled": 0,
                "account_name": "GST 5%",
                "is_group": 0,
                "company": company,
                "root_type": "Liability",
                "report_type": "Balance Sheet",
                "account_currency": "CAD",
                "parent_account":taxes_account,
                "account_type": "Tax",
                "tax_rate": "5",
                "freeze_account": "No",
                "balance_must_be": "",
                "old_parent":taxes_account,
                "include_in_gross": 0,
                })
            gst_name=gst["name"]

        taxes_template_data=frappe.get_all("Sales Taxes and Charges Template",
            filters = {
                "company":company,
                "title": "Canada PST 14.975%",
            },
            fields=["name"])
        costs_center=frappe.get_all("Company",
            filters = {
                "company_name":company,
            },
            fields=["cost_center"])
        
        if(len(costs_center)==0):
            return json.dumps({"message":"Failed to find the cost center !","success":0})
        cost_center=costs_center[0]["cost_center"]
        if(len(taxes_template_data)==0):
            taxes_template=frappe.client.insert(doc=
                                {
                                "docstatus": 0,
                                "idx": 0,
                                "title": "Canada PST 14.975%",
                                "is_default": 1,
                                "disabled": 0,
                                "company": company,
                                "doctype": "Sales Taxes and Charges Template",
                                "taxes": [
                                {
                                    "docstatus": 0,
                                    "idx": 1,
                                    "charge_type": "On Net Total",
                                    "account_head": gst_name,
                                    "description": "GST 5%",
                                    "included_in_print_rate": 0,
                                    "included_in_paid_amount": 0,
                                    "cost_center": cost_center,
                                    "rate": 5.0,
                                    "account_currency": "CAD",
                                    "tax_amount": 0.0,
                                    "total": 0.0,
                                    "tax_amount_after_discount_amount": 0.0,
                                    "base_tax_amount": 0.0,
                                    "base_total": 0.0,
                                    "base_tax_amount_after_discount_amount": 0.0,
                                    "dont_recompute_tax": 0,
                                    "parentfield": "taxes",
                                    "parenttype": "Sales Taxes and Charges Template",
                                    "doctype": "Sales Taxes and Charges"
                                },
                                {
                                    "docstatus": 0,
                                    "idx": 2,
                                    "charge_type": "On Net Total",
                                    "account_head": qst_name,
                                    "description": "QST 9.975%",
                                    "included_in_print_rate": 0,
                                    "included_in_paid_amount": 0,
                                    "cost_center": cost_center,
                                    "rate": 9.975,
                                    "account_currency": "CAD",
                                    "tax_amount": 0.0,
                                    "total": 0.0,
                                    "tax_amount_after_discount_amount": 0.0,
                                    "base_tax_amount": 0.0,
                                    "base_total": 0.0,
                                    "base_tax_amount_after_discount_amount": 0.0,
                                    "dont_recompute_tax": 0,
                                    "parentfield": "taxes",
                                    "parenttype": "Sales Taxes and Charges Template",
                                    "doctype": "Sales Taxes and Charges"
                                }
                                ]
                            })
            taxes_template_name=taxes_template["name"]
        else:
            taxes_template_name=taxes_template_data[0]["name"]
        

        
        taxes_category_data=frappe.get_all("Tax Category",
            filters = {
                "name":"Ca Taxes",
            },
            fields=["name"])
        
        if(len(taxes_category_data)==0):
            frappe.client.insert(doc= {
                "name": "Ca Taxes",
                "docstatus": 0,
                "title": "Ca Taxes",
                "disabled": 0,
                "doctype": "Tax Category"
            })
        
        taxes_rules_data=frappe.get_all("Tax Rule",
            filters = {
                "sales_tax_template":taxes_template_name,
                "company": company,
            },
            fields=["name"])
        
        tax_rule_name=""

        if(len(taxes_rules_data)==0):
            tax_rule=frappe.client.insert(doc= {
                "docstatus": 0,
                "tax_type": "Sales",
                "use_for_shopping_cart": 1,
                "sales_tax_template":taxes_template_name,
                "billing_country": "Canada",
                "tax_category": "Ca Taxes",
                "shipping_country": "Canada",
                "priority": 1,
                "company": company,
                "doctype": "Tax Rule"
            })
            tax_rule_name=tax_rule["name"]
        else:
            tax_rule_name=taxes_rules_data[0]["name"]
        return json.dumps({"message":"Taxes created successfully! ('taxes_template':"+taxes_template_name+",'tax_rule':"+tax_rule_name+")","status":"Success"})
    except : 
        return json.dumps({"message":"An error has occured while trying to create taxes","status":"Error"})
    