var scriptElement = document.createElement('script');
scriptElement.src = 'https://cdn.jsdelivr.net/npm/sweetalert2@11/dist/sweetalert2.all.min.js';
document.head.appendChild(scriptElement);
frappe.ui.form.on('Invoice Import Tool', {
    refresh: function(frm) {        
        $("input[data-fieldname='generated_sales']").prop("disabled",true);
        $("input[data-fieldname='generated_purchase']").prop("disabled",true);
        $("button[data-fieldname='extract_data']").off('click').on('click',(e)=>{
            if($("button[data-fieldname='extract_data']").prop("disabled")){
                return;
            }
            $("button[data-fieldname='extract_data']").prop("disabled",true);
                let field_empty=false;
                if(!frm.doc.gpt_account){
                    $("input[data-fieldname='gpt_account']").css({
                        "border-color": "red",
                        "border-width": "1px",
                        "border-style": "solid"
                    });
                    field_empty=true;
                }
                if(!frm.doc.invoice_file){
                    $("div[data-fieldname='invoice_file']").find("div[class='control-input']").css({
                        "border-color": "red",
                        "border-width": "1px",
                        "border-style": "solid"
                    });
                    field_empty=true;

                }
                if(field_empty){
                    Swal.fire({
                        icon: 'warning',
                        title: 'Empty fields!',
                        text: 'Please fill empty fields first',
                    });
                    setTimeout(()=>{
                        $("input[data-fieldname='gpt_account']").css({
                            "border": "None",
                        });
                        $("div[data-fieldname='invoice_file']").find("div[class='control-input']").css({
                            "border": "None",
                        });

                    }, 4000);
                    $("button[data-fieldname='extract_data']").prop("disabled",false);
                    return;
                }
                $("input[data-fieldname='gpt_account']").css({
                    "border-color": "green",
                    "border-width": "1px",
                    "border-style": "solid"
                });
                $("div[data-fieldname='invoice_file']").find("div[class='control-input']").css({
                    "border-color": "green",
                    "border-width": "1px",
                    "border-style": "solid"
                });
                setTimeout(()=>{
                    $("input[data-fieldname='gpt_account']").css({
                        "border": "None",
                    });
                    $("div[data-fieldname='invoice_file']").find("div[class='control-input']").css({
                        "border": "None",
                    });

                }, 4000);
                frappe.call(
                    {
                        method: "ipconnex_ai_invoice.ipconnex_ai_invoice.extract.extractPDFData",
                        args:{
                            "doc_name":frm.doc.invoice_type=="Purchase"?"Supplier":"Customer",
                            "pdf_path":frm.doc.invoice_file,
                            "account_name":frm.doc.gpt_account,
                
                            },            
                    callback: function(response) {  
                        let res_json=JSON.parse(response.message);
                        console.log(response.message);
                        let invoice_data={};
                        if(res_json["status"]){
                            try{
                                invoice_data=JSON.parse(res_json["message"]);
                            }catch(e){
                                Swal.fire({
                                    icon: 'error',
                                    title: 'Response Error!',
                                    text: 'Failed to parse Chat Gpt Response',
                                });
                                return;
                            }
                            try{
                                if( frm.doc.invoice_type=="Purchase"){
                                    frm.set_value({"supplier_name":invoice_data["company"]});
                                }            
                                if( frm.doc.invoice_type=="Sales"){
                                    frm.set_value({"customer_name":invoice_data["company"]});
                                }

                            }catch(e){
                                console.log(e);
                            }
                            

                            try{
                                frm.set_value({"extracted_amount":invoice_data['total_amount']})
                            }catch(e){
                                console.log(e);
                            }
                            
                            try{
                                frm.set_value({"invoice_date":invoice_data['invoice_date']})
                            }catch(e){
                                console.log(e);
                            }

                            try{
                                frm.set_value({"currency":invoice_data['currency']});
                            }catch(e){
                                console.log(e);
                            }
                            
                            try{
                                let items=invoice_data['invoice_items'];
                                console.log(items);
                                let amount= 0 ;
                                let invoice_items=[];
                                for(let i in items){

                                    amount+=parseInt(items[i].amount*100);
                                    invoice_items.push({
                                        "item_code":  ""  ,
                                        "item_description":items[i].item_description,
                                        "item_qty": 1    ,
                                        "item_rate": items[i].amount  , 
                                        "item_amount":items[i].amount
                                    });
                                }
                                frm.set_value({"invoice_items":invoice_items});
                                frm.set_value({"invoice_total_amount":amount/100,"difference": Math.abs(amount- parseInt(frm.doc.extracted_amount)*100) /100});
                            }catch(e){
                                console.log(e);
                            }
                        }else{
                            Swal.fire({
                                title: 'Fail !',
                                text:  res_json["message"],
                                icon: 'error',
                            });
                        }
                        $("button[data-fieldname='extract_data']").prop("disabled",false);
                    }});
            });

            $("button[data-fieldname='generate_invoice']").off('click').on('click',(e)=>{
                if($("button[data-fieldname='generate_invoice']").prop("disabled")){
                    return;
                }
                let items= frm.doc.invoice_items;
                let inv_items=[];
                for(let i in items){
                    if(!items[i].item_code){
                        Swal.fire({
                            icon: 'warning',
                            title: 'Empty fields !',
                            text: 'Please fill item codes first',
                        });
                        return;
                    }
                    let inv_item= {
                            'item_code': items[i].item_code,
                            'qty': 1.0,
                            'description':items[i].description,
                            'rate': items[i].rate,
                            'amount': items[i].rate ,
                        }
                    if( frm.doc.invoice_type=="Sales"){
                        inv_item['income_account']=frm.doc.income_account;
                    }
                    inv_items.push(inv_item);
                }
                $("button[data-fieldname='generate_invoice']").prop("disabled",true); 
                let due_date_obj= new Date( cur_frm.doc.invoice_date);
                due_date_obj.setDate( due_date_obj.getDate() + 30);
                let due_date=due_date_obj.toISOString().split('T')[0];

    
                if( frm.doc.invoice_type=="Purchase"){
                    frappe.db.insert({
                        'supplier': frm.doc.supplier_name,
                        'posting_date': cur_frm.doc.invoice_date,
                        'due_date': due_date,
                        'company': frm.doc.company,
                        'currency': frm.doc.currency,
                        'items': inv_items,
                        "doctype":"Purchase Invoice"
                    }).then((response)=>{
                        frm.set_value({"generated_purchase":response.name});
                        frm.save();
                    });
                }            
                if( frm.doc.invoice_type=="Sales"){
                    frappe.db.insert({
                        'customer': frm.doc.customer_name,
                        'posting_date': cur_frm.doc.invoice_date,
                        'due_date': due_date,
                        'company': frm.doc.company,
                        'items': inv_items,
                        "doctype":"Sales Invoice"
                    }).then((response)=>{
                        frm.set_value({"generated_sales":response.name});
                        frm.save();
                    });
                }
                $("button[data-fieldname='generate_invoice']").prop("disabled",false);
            });
    },
    gpt_account:function(frm){
        if(frm.doc.gpt_account){
            frappe.db.get_value("GPT Setting",frm.doc.gpt_account,"company").then((response)=>{
                try{
                    frm.set_value({"company":response.message.company})
                }catch(e){
                }
            })
        }
    },
});
frappe.ui.form.on('Invoice Import Tool Item', {
    item_qty: function(frm, cdt, cdn) { 
        setTimeout(function() {
            let item=locals[cdt][cdn];
            item.item_amount=item.item_rate*item.item_qty;
            frm.refresh_field("invoice_items");
            let amount=0;
                for(let i in frm.doc.invoice_items ){
                    let inv_item=frm.doc.invoice_items[i]
                    amount+=parseInt(inv_item.item_amount*100)*inv_item.item_qty;
                }
            frm.set_value({"invoice_total_amount":amount/100,"difference": Math.abs(amount-parseInt(frm.doc.extracted_amount*100)) /100});
        }, 300);
    },
    item_rate: function(frm, cdt, cdn) { 
        setTimeout(function() {
            let item=locals[cdt][cdn];
            item.item_amount=item.item_rate*item.item_qty;
            frm.refresh_field("invoice_items");
            let amount=0;
                for(let i in frm.doc.invoice_items ){
                    let inv_item=frm.doc.invoice_items[i]
                    amount+=parseInt(inv_item.item_amount*100)*inv_item.item_qty;
                }
                frm.set_value({"invoice_total_amount":amount/100,"difference": Math.abs(amount-parseInt(frm.doc.extracted_amount*100)) /100});
        }, 300);
    },
    invoice_items_remove:function(frm, cdt, cdn){
        setTimeout(function() {
            let amount=0;
            for(let i in cur_frm.doc.invoice_items ){
                let inv_item=cur_frm.doc.invoice_items[i];
                amount+=parseInt(inv_item.item_amount*100)*inv_item.item_qty;
            }
            cur_frm.set_value({"invoice_total_amount":amount/100,"difference": Math.abs(amount-parseInt(cur_frm.doc.extracted_amount*100)) /100});
        }, 300);

    },
});
