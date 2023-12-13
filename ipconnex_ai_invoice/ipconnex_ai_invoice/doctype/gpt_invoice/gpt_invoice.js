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
                if(!cur_frm.doc.gpt_account){
                    $("input[data-fieldname='gpt_account']").css({
                        "border-color": "red",
                        "border-width": "1px",
                        "border-style": "solid"
                    });
                    field_empty=true;
                }
                if(!cur_frm.doc.invoice_file){
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
                            console.log("todo fill fields");
                            console.log(res_json["message"]);
                            //todo fill fields using res_json["message"]


                        }else{
                            Swal.fire({
                                title: 'Fail !',
                                text:  res_json["message"],
                                icon: 'error',
                            });
                        }
                    
                    }});
                $("button[data-fieldname='extract_data']").prop("disabled",false);
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
                }).then(response()=>{})*/


            }            
            if( frm.doc.invoice_type=="Sales"){
                console.log("Generate Sales Invoice");
                /* TODO insert Sales Invoice
                frappe.db.insert({



                    "doctype":"Sales Invoice"
                }).then(response()=>{})*/


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
    }
});
frappe.ui.form.on('GPT Invoice Item', {
    item_code: function(frm, cdt, cdn) { 
            let item=locals[cdt][cdn];
            frappe.db.get_doc("Item",item.item_code).then((res)=>{
              item.item_rate=res.standard_rate;
              item.item_qty=1;
              item.item_amount=res.standard_rate;
              frm.refresh_field("invoice_items");
            });
    },
    item_qty: function(frm, cdt, cdn) { 
            let item=locals[cdt][cdn];
            item.item_amount=item.item_rate*item.item_qty;
            frm.refresh_field("invoice_items");
    },
    item_rate: function(frm, cdt, cdn) { 
        let item=locals[cdt][cdn];
        item.item_amount=item.item_rate*item.item_qty;
        frm.refresh_field("invoice_items");
    },
    
});
