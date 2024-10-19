
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

@frappe.whitelist()
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
        model=frappe.db.get_value("GPT Setting",account_name,"gpt_model")
        api_key=frappe.db.get_value("GPT Setting",account_name,"gpt_key")
        full_path=""+frappe.db.get_value("GPT Setting",account_name,"storage_dir")+pdf_path
    except :
        return json.dumps({"status":"0","message":"Failed to get GPT Setting data "})
    try :
        companies=[ company["name"] for company in frappe.db.get_all(doc_name,fields=['name']) ]
        pdf_text = extract_text_from_pdf(full_path)    
    except :
        return json.dumps({"status":"0","message":"Failed to read PDF"})
    try:
        question = "Please give me all details of this invoice in an JSON format. dont put any character outside the json . the answer should be parsable into json . I want the JSON to contain this info with this keys: {'company': company , 'invoice_date': 'yyyy-mm-dd','total_amount': total_charges_float,'currency': currency_in_3_letters_uppercase , 'invoice_items': [{'item_description': item_description ,'rate': rate ,'duration':duration_as_string ,'amount': 'charges is the last data in the batch'}]} . items must be an array of objects without including the total . take attention for amounts written with spaces each 3 numbers like  \"9   999 999.99\" or \"9    999.99\". make sure each amount extracted (or charges or price or any synonym ) is indexed by a label which is a synonym to amount charges price is the last item of the item data list  . and its always the last column of the data vatcg its not a duration nor a rate. make sure to not specify the currency in ammounts. make sure the result could be parsed as json  . Here's a list of all customers, choose the object that fits best: " + ', '.join(companies) +  " to put in the json data after without editing anything. and here's a text extracted from an invoice pdf document: " + pdf_text
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


