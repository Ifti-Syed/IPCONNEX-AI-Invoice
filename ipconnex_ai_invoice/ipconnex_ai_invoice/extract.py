
from __future__ import unicode_literals
import frappe
import json
from six import string_types
from frappe import _
from frappe.utils import flt
import stripe
import random
import time
from PyPDF2 import PdfReader 
from openai import OpenAI




def extract_text_from_pdf(pdf_path):
    with open(pdf_path, 'rb') as file:
        pdf_reader = PdfReader(file)
        text = ''
        for page_num in range(len(pdf_reader.pages)):
            page = pdf_reader.pages[page_num]
            text += page.extract_text()
    return text

def ask_chatgpt(question,model,api_key):
    client = OpenAI(api_key=api_key)
    chat_completion = client.chat.completions.create(
        messages=[
            {
                "role": "user",
                "content": question,
            }
        ],
        model=model
    )
    return chat_completion


@frappe.whitelist()
def extractPDFData(doc_name,pdf_path,account_name):
    full_path=pdf_path
    try:
        model=frappe.db.get_value("GPT Account",account_name,"gpt_model")
        api_key=frappe.db.get_value("GPT Account",account_name,"gpt_key")
        full_path=""+frappe.db.get_value("GPT Account",account_name,"storage_dir")+pdf_path
    except :
        return json.dumps({"status":"0","message":"Failed to get GPT Account data "})
    try :
        companies=[ company["name"] for company in frappe.db.get_all(doc_name,fields=['name']) ]
        pdf_text = extract_text_from_pdf(full_path)    
    except :
        return json.dumps({"status":"0","message":"Failed to read PDF"})
    try:
        question = "Please ive me all details of this invoice in an JSON format. I want the JSON to contain this info with this keys: {'company': company , 'invoice_date': 'yyyy-mm-dd', 'invoice_items': {'item_description': item_description,'duration':duration ,'amount': amount} } while the amount in invoice_items is the amount of the item in dollars not the duration. Here's a list of all customers, choose the one that fits best: " + ', '.join(companies) +  ". and here's a text extracted from an invoice pdf document: " + pdf_text
        answer = ask_chatgpt(question,model,api_key).choices[0].message.content
    except :
        return json.dumps({"status":"0","message":"There is an error while using ChatGPT API "})
    return json.dumps({"status":"1","message":""+answer})


@frappe.whitelist()
def getSiteName():
    try: 
        return json.dumps({"status":"1",
                           "message":"/home/frappe/frappe-bench/sites/"+(frappe.local.site)})
    except Exception as e:
        return json.dumps({"status":"0","message":'We got an error while trying to get the default storage path'})


