frappe.ui.form.on('GPT Invoice', {
    refresh: function(frm) {        


        var scriptElement = document.createElement('script');
        scriptElement.src = 'https://cdn.jsdelivr.net/npm/sweetalert2@11/dist/sweetalert2.all.min.js';
        document.head.appendChild(scriptElement);
        $("input[data-fieldname='generated_sales']").prop("disabled",true);
        $("input[data-fieldname='generated_purchase']").prop("disabled",true);
        $("button[data-fieldname='extract_data']").click((e)=>{
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
                            "doc_name":cur_frm.doc.invoice_type=="Purchase"?"Supplier":"Customer",
                            "pdf_path":cur_frm.doc.invoice_file,
                            "account_name":cur_frm.doc.gpt_account,
                
                            },            
                    callback: function(response) {  
                        let res_json=JSON.parse(response.message);
                        if(res_json["status"]){
                            let invoice_data=JSON.parse(res_json["message"])
                            console.log();
                            try{
                                if( cur_frm.doc.invoice_type=="Purchase"){
                                    cur_frm.set_value({"supplier_name":invoice_data["company"]});
                                }            
                                if( cur_frm.doc.invoice_type=="Sales"){
                                    cur_frm.set_value({"customer_name":invoice_data["company"]});
                                }

                            }catch(e){
                                console.log(e);
                            }

                            try{
                                cur_frm.set_value({"invoice_date":invoice_data['invoice_date']})
                            }catch(e){
                                console.log(e);
                            }
                            try{

                                let items=invoice_data['invoice_items'];
                                console.log(items);
                                frappe.db.get_value("GPT Account","GPT-IPCo-842","gpt_default_item").then((response)=>{ 
                                let invoice_items=[];
                                for(let i in items){
                                    invoice_items.push({
                                        "item_code":  response.message.gpt_default_item  ,
                                        "item_description":items[i].item_description,
                                        "item_qty": 1    ,
                                        "item_rate": items[i].amount  , 
                                        "item_amount":items[i].amount
                                    });
                                }
                                    
                                cur_frm.set_value({"invoice_items":invoice_items});
                                })
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
        $("button[data-fieldname='generate_invoice']").click((e)=>{
            if($("button[data-fieldname='generate_invoice']").prop("disabled")){
                return;
            }
            $("button[data-fieldname='generate_invoice']").prop("disabled",true);  
            if( frm.doc.invoice_type=="Purchase"){
                
                console.log("Generate Purchase Invoice");
                /*
                frappe.db.insert({



                    "doctype":"Purchase Invoice"
                }).then((response)=>{
                    TODO replace the static value with the new purchase name 
                    cur_frm.set_value({"generated_sales":"ACC-SINV-2023-00001"});
                    cur_frm.save()


                })
                
                */


            }            
            if( frm.doc.invoice_type=="Sales"){
                console.log("Generate Sales Invoice");
                /* TODO insert Sales Invoice
                frappe.db.insert({



                    "doctype":"Sales Invoice"
                }).then((response)=>{
                    TODO replace the static value with the new purchase name 
                    cur_frm.set_value({"generated_purchase":"ACC-SINV-2023-00001"});
                    cur_frm.save()


                })*/


            }




            
            $("button[data-fieldname='generate_invoice']").prop("disabled",false);
        })





    },
    gpt_account:function(frm){
        if(frm.doc.gpt_account){
            frappe.db.get_value("GPT Account",frm.doc.gpt_account,"company").then((response)=>{
                try{
                    frm.set_value({"company":response.message.company})
                }catch(e){
                }
            })
        }
    },
});
frappe.ui.form.on('GPT Invoice Item', {
    item_code: function(frm, cdt, cdn) { 
            let item=locals[cdt][cdn];
            frappe.db.get_doc("Item",item.item_code).then((res)=>{
                item.item_rate=res.standard_rate;
                item.item_qty=1;
                item.item_amount=res.standard_rate;
                frm.refresh_field("invoice_items");
                let amount=0;
                    for(let i in frm.doc.invoice_items ){
                        amount+=parseInt(frm.doc.invoice_items[i].item_amount*100);
                    }
                frm.set_value({"invoice_total_amount":amount/100})
            });
    },
    item_qty: function(frm, cdt, cdn) { 
            let item=locals[cdt][cdn];
            item.item_amount=item.item_rate*item.item_qty;
            frm.refresh_field("invoice_items");
            let amount=0;
                for(let i in frm.doc.invoice_items ){
                    amount+=parseInt(frm.doc.invoice_items[i].item_amount*100);
                }
            frm.set_value({"invoice_total_amount":amount/100})
            
    },
    item_rate: function(frm, cdt, cdn) { 
        let item=locals[cdt][cdn];
        item.item_amount=item.item_rate*item.item_qty;
        frm.refresh_field("invoice_items");
        let amount=0;
            for(let i in frm.doc.invoice_items ){
                amount+=parseInt(frm.doc.invoice_items[i].item_amount*100);
            }
            frm.set_value({"invoice_total_amount":amount/100})
        
    }
});
