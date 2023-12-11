frappe.ui.form.on('GPT Invoice', {
    refresh: function(frm) {

        $("input[data-fieldname='generated_sales']").prop("disabled",true);
        $("input[data-fieldname='generated_purchase']").prop("disabled",true);

    }
                    
});
