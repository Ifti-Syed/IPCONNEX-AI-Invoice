console.log("🔥 NEW Invoice Import Tool JS LOADED 🔥");
var scriptElement = document.createElement("script");
scriptElement.src =
  "https://cdn.jsdelivr.net/npm/sweetalert2@11/dist/sweetalert2.all.min.js";
document.head.appendChild(scriptElement);
frappe.ui.form.on("Invoice Import Tool", {
  refresh: function (frm) {
    $("input[data-fieldname='generated_sales']").prop("readonly", true);
    $("input[data-fieldname='generated_purchase']").prop("readonly", true);

    // -------------------------------
    // EXTRACT BUTTON
    // -------------------------------
    $("button[data-fieldname='extract_data']")
      .off("click")
      .on("click", function () {
        if ($(this).prop("disabled")) return;

        // -------------------------------
        // Validation
        // -------------------------------
        let has_error = false;

        if (!frm.doc.gpt_account) {
          frm.toggle_reqd("gpt_account", true);
          has_error = true;
        }

        if (!frm.doc.invoice_file) {
          frm.toggle_reqd("invoice_file", true);
          has_error = true;
        }

        if (has_error) {
          Swal.fire({
            icon: "warning",
            title: "Missing Fields",
            text: "Please select GPT Account and upload Invoice file",
          });
          return;
        }

        $(this).prop("disabled", true);

        // -------------------------------
        // Call NEW Vision API
        // -------------------------------
        frappe.call({
          method:
            "ipconnex_ai_invoice.ipconnex_ai_invoice.extract.extract_invoice_with_vision",
          freeze: true,
          args: {
            pdf_path: frm.doc.invoice_file,
            company_doctype: "Company",
            account_name: frm.doc.gpt_account,
          },
          callback(r) {
            $("button[data-fieldname='extract_data']").prop("disabled", false);

            if (!r.message || r.message.status !== 1) {
              Swal.fire({
                icon: "error",
                title: "Extraction Failed",
                text: r.message?.error || "Unknown error",
              });
              return;
            }

            const data = r.message.data;

            console.log("Extracted Invoice Data:", data);

            // -------------------------------
            // Header Fields
            // -------------------------------
            if (frm.doc.invoice_type === "Purchase") {
              frm.set_value("supplier_name", data.supplier || "");
            }

            if (frm.doc.invoice_type === "Sales") {
              frm.set_value("customer_name", data.company || "");
            }

            frm.set_value("invoice_date", data.bill_date || "");
            frm.set_value("currency", data.currency || frm.doc.currency);
            frm.set_value("extracted_amount", data.total_amount || 0);

            // -------------------------------
            // Items Table
            // -------------------------------
            let items = data.items || [];
            let invoice_items = [];
            let total = 0;

            items.forEach((row) => {
              if (!row.amount || row.amount <= 0) return;

              invoice_items.push({
                item_code: frm.doc.invoice_default_item || "",
                item_description: row.item_description || row.item_name || "",
                item_qty: row.qty || 1,
                item_rate: row.rate || row.amount,
                item_amount: row.amount,
                // 👇 ADD THESE
                uom: row.uom || "",
                expense_account: row.expense_account || ""

              });

              total += Math.round(row.amount * 100);
            });

            frm.set_value("invoice_items", invoice_items);

            frm.set_value({
              invoice_total_amount: total / 100,
              difference:
                Math.abs(
                  total - Math.round((data.total_amount || 0) * 100)
                ) / 100,
            });

            Swal.fire({
              icon: "success",
              title: "Extraction Completed",
              text: "Invoice data extracted successfully",
            });
          },
        });
      });

    // -------------------------------
    // GENERATE INVOICE (UNCHANGED)
    // -------------------------------
    $("button[data-fieldname='generate_invoice']")
      .off("click")
      .on("click", (e) => {
        if ($("button[data-fieldname='generate_invoice']").prop("disabled")) {
          return;
        }
        let items = frm.doc.invoice_items;
        let inv_items = [];
        for (let i in items) {
          if (!items[i].item_code) {
            Swal.fire({
              icon: "warning",
              title: "Empty fields !",
              text: "Please fill items codes first",
            });
            return;
          }
          let inv_item = {
            item_code: items[i].item_code,
            qty: 1.0,
            description: items[i].description,
            rate: items[i].item_rate,
            amount: items[i].item_rate,
          };
          if (frm.doc.invoice_type == "Sales") {
            inv_item["income_account"] = frm.doc.income_account;
          }
          inv_items.push(inv_item);
        }
        $("button[data-fieldname='generate_invoice']").prop("disabled", true);
        let due_date_obj = new Date(frm.doc.invoice_date);
        due_date_obj.setDate(due_date_obj.getDate() + 30);
        let due_date = due_date_obj.toISOString().split("T")[0];
        let company_name = frm.doc.company;
        console.log(company_name);
        if (frm.doc.invoice_type == "Purchase") {
          frappe.db
            .get_doc("Supplier", frm.doc.supplier_name)
            .then((supplier_doc) => {
              if (supplier_doc.accounts.length > 0) {
                company_name = supplier_doc.accounts[0].company;
                console.log(company_name);
              }
              frappe.call({
                method: "erpnext.accounts.party.get_party_details",
                args: {
                  posting_date: frm.doc.invoice_date,
                  party: frm.doc.supplier_name,
                  party_type: "Supplier",
                  account: "",
                  price_list: "",
                  company_address: "",
                  currency: "",
                  company: company_name,
                  doctype: "Purchase Invoice",
                },
                callback: function (response) {
                  if (response.message.taxes_and_charges) {
                    /// get taxes
                    frappe.call({
                      method:
                        "erpnext.controllers.accounts_controller.get_taxes_and_charges",
                      args: {
                        master_doctype: "Purchase Taxes and Charges Template",
                        master_name: response.message.taxes_and_charges,
                      },
                      callback: function (taxes_response) {
                        frappe.db
                          .insert({
                            supplier: frm.doc.supplier_name,
                            posting_date: frm.doc.invoice_date,
                            due_date: due_date,
                            company: company_name,
                            currency: frm.doc.currency,
                            items: inv_items,
                            taxes: taxes_response.message,
                            doctype: "Purchase Invoice",
                          })
                          .then((response) => {
                            frm.set_value({
                              generated_purchase: response.name,
                            });
                            if (frm.doc.invoice_file) {
                              frappe.db.insert({
                                is_private: 1,
                                file_url: frm.doc.invoice_file,
                                attached_to_doctype: "Purchase Invoice",
                                attached_to_name: response.name,
                                doctype: "File",
                              });
                            }
                            frm.save();
                          });
                      },
                    });
                  } else {
                    // add witout taxes
                    frappe.db
                      .insert({
                        supplier: frm.doc.supplier_name,
                        posting_date: frm.doc.invoice_date,
                        due_date: due_date,
                        company: company_name,
                        currency: frm.doc.currency,
                        items: inv_items,
                        doctype: "Purchase Invoice",
                      })
                      .then((response) => {
                        frm.set_value({ generated_purchase: response.name });
                        if (frm.doc.invoice_file) {
                          frappe.db.insert({
                            is_private: 1,
                            file_url: frm.doc.invoice_file,
                            attached_to_doctype: "Purchase Invoice",
                            attached_to_name: response.name,
                            doctype: "File",
                          });
                        }
                        frm.save();
                      });
                  }
                },
              });
            });
        }
        if (frm.doc.invoice_type == "Sales") {
          frappe.db
            .get_doc("Customer", frm.doc.customer_name)
            .then((customer_doc) => {
              if (customer_doc.accounts.length > 0) {
                company_name = customer_doc.accounts[0].company;
                console.log(company_name);
              }
              frappe.call({
                method: "erpnext.accounts.party.get_party_details",
                args: {
                  posting_date: frm.doc.invoice_date,
                  party: frm.doc.customer_name,
                  party_type: "Customer",
                  account: "",
                  price_list: "",
                  company_address: "",
                  currency: "",
                  company: company_name,
                  doctype: "Sales Invoice",
                },
                callback: function (response) {
                  console.log(response);
                  if (response.message.taxes_and_charges) {
                    // get taxes
                    frappe.call({
                      method:
                        "erpnext.controllers.accounts_controller.get_taxes_and_charges",
                      args: {
                        master_doctype: "Sales Taxes and Charges Template",
                        master_name: response.message.taxes_and_charges,
                      },
                      callback: function (taxes_response) {
                        frappe.db
                          .insert({
                            customer: frm.doc.customer_name,
                            posting_date: frm.doc.invoice_date,
                            due_date: due_date,
                            company: company_name,
                            currency: frm.doc.currency,
                            items: inv_items,
                            taxes: taxes_response.message,
                            doctype: "Sales Invoice",
                          })
                          .then((response) => {
                            frm.set_value({
                              generated_purchase: response.name,
                            });
                            if (frm.doc.invoice_file) {
                              frappe.db.insert({
                                is_private: 1,
                                file_url: frm.doc.invoice_file,
                                attached_to_doctype: "Sales Invoice",
                                attached_to_name: response.name,
                                doctype: "File",
                              });
                            }
                            frm.save();
                          });
                      },
                    });
                  } else {
                    // add without taxes
                    frappe.db
                      .insert({
                        customer: frm.doc.customer_name,
                        posting_date: frm.doc.invoice_date,
                        due_date: due_date,
                        company: company_name,
                        items: inv_items,
                        doctype: "Sales Invoice",
                      })
                      .then((response) => {
                        frm.set_value({ generated_sales: response.name });
                        if (frm.doc.invoice_file) {
                          frappe.db.insert({
                            is_private: 1,
                            file_url: frm.doc.invoice_file,
                            attached_to_doctype: "Sales Invoice",
                            attached_to_name: response.name,
                            doctype: "File",
                          });
                        }
                        frm.save();
                      });
                  }
                },
              });
            });
        }
        $("button[data-fieldname='generate_invoice']").prop("disabled", false);
      });
  },

  // -------------------------------
  // Auto-set company from GPT Setting
  // -------------------------------
  gpt_account(frm) {
    if (!frm.doc.gpt_account) return;

    frappe.db
      .get_value("GPT Setting", frm.doc.gpt_account, "company")
      .then((r) => {
        if (r.message?.company) {
          frm.set_value("company", r.message.company);
        }
      });
  },
});

// ---------------------------------
// Item Table Calculations
// ---------------------------------
frappe.ui.form.on("Invoice Import Tool Item", {
  item_qty(frm, cdt, cdn) {
    recalc_items(frm);
  },
  item_rate(frm, cdt, cdn) {
    recalc_items(frm);
  },
  invoice_items_remove(frm) {
    recalc_items(frm);
  },
});

function recalc_items(frm) {
  setTimeout(() => {
    let total = 0;

    (frm.doc.invoice_items || []).forEach((row) => {
      row.item_amount = (row.item_rate || 0) * (row.item_qty || 1);
      total += Math.round(row.item_amount * 100);
    });

    frm.refresh_field("invoice_items");

    frm.set_value({
      invoice_total_amount: total / 100,
      difference:
        Math.abs(
          total - Math.round((frm.doc.extracted_amount || 0) * 100)
        ) / 100,
    });
  }, 200);
}




