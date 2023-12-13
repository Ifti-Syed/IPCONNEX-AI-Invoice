frappe.ui.form.on('GPT Account', {
    refresh: function(frm) {
        var scriptElement = document.createElement('script');
        scriptElement.src = 'https://cdn.jsdelivr.net/npm/sweetalert2@11/dist/sweetalert2.all.min.js';
        document.head.appendChild(scriptElement);

        if(frm.doc.name.startsWith("new-gpt-account-")){
            frappe.call(
                {
                    method: "ipconnex_ai_invoice.ipconnex_ai_invoice.extract.getSiteName",
                    callback: function(response) {
                    let res_json=JSON.parse(response.message);
                    if(res_json["status"]){
                        cur_frm.set_value({"storage_dir":res_json["message"]});
                    }else{
                        Swal.fire({
                            title: 'Fail !',
                            text: res_json["message"],
                            icon: 'error',
                        });
                    }
                }});
        }
    }             
});
