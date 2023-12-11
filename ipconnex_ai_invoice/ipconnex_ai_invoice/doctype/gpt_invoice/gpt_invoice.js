frappe.ui.form.on('GPT Invoice', {
    refresh: function(frm) {

        $("input[data-fieldname='generated_sales']").prop("disabled",true);
        $("input[data-fieldname='generated_purchase']").prop("disabled",true);
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
