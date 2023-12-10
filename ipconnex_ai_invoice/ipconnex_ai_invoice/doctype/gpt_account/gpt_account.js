frappe.ui.form.on('GPT Account', {
    refresh: function(frm) {
        $("input[data-fieldname='gpt_balance']").prop("disabled",true);

        
    }
                    
});
