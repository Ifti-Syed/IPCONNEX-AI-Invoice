frappe.ui.form.on("Cvs Invoice Tool", {
  refresh(frm) {
    frm.set_df_property("generated_sales", "read_only", 1);
    frm.set_df_property("generated_purchase", "read_only", 1);

    toggle_mode_of_payment(frm);
    toggle_cash_bank_account(frm);

    // -----------------------------------------------
    // EXTRACT DATA
    // -----------------------------------------------
    $("button[data-fieldname='extract_data']")
      .off("click")
      .on("click", () => {
        if ($("button[data-fieldname='extract_data']").prop("disabled")) return;

        let missing = [];
        if (!frm.doc.gpt_account) missing.push(__("GPT Account"));
        if (!frm.doc.invoice_file) missing.push(__("Invoice File"));

        if (missing.length) {
          frappe.msgprint({
            title: __("Required Fields Missing"),
            message: __("Please fill in the following fields before extracting: {0}", [
              "<br><ul><li>" + missing.join("</li><li>") + "</li></ul>",
            ]),
            indicator: "orange",
          });
          return;
        }

        $("button[data-fieldname='extract_data']").prop("disabled", true);
        frappe.dom.freeze(__("Extracting invoice data with AI — this may take a moment..."));

        frappe.call({
          method:
            "ipconnex_ai_invoice.ipconnex_ai_invoice.extract.extract_invoice_with_vision",
          args: {
            pdf_path: frm.doc.invoice_file,
            company_doctype: "Company",
            account_name: frm.doc.gpt_account,
          },
          callback(r) {
            frappe.dom.unfreeze();
            $("button[data-fieldname='extract_data']").prop("disabled", false);

            if (!r.message || r.message.status !== 1) {
              frappe.msgprint({
                title: __("Extraction Failed"),
                message:
                  r.message?.error ||
                  __("The AI could not extract data from this file. Please check the file and try again."),
                indicator: "red",
              });
              return;
            }

            const data = r.message.data;

            if (frm.doc.invoice_type === "Purchase") {
              frm.set_value("supplier_name", data.supplier || "");
              frm.set_value("supplier_invoice_no", data.bill_no || "");
              frm.set_value("supplier_invoice_date", data.bill_date || "");
            } else {
              frm.set_value("customer_name", data.company || "");
            }

            frm.set_value("invoice_date", data.bill_date || "");
            frm.set_value("currency", data.currency || frm.doc.currency);

            if (r.message.duplicate_warning) {
              frappe.msgprint({
                title: __("Duplicate Supplier Bill"),
                message: r.message.duplicate_warning,
                indicator: "orange",
              });
            }
            frm.set_value("extracted_amount", data.total_amount || 0);

            let items = data.items || [];
            let invoice_items = [];
            let total = 0;

            items.forEach((row) => {
              if (!row.amount || row.amount <= 0) return;
              invoice_items.push({
                item_code:
                  row.item_code || frm.doc.invoice_default_item || "99-Purchases",
                item_description:
                  row.item_description || row.item_name || "Auto-imported item",
                item_qty: row.qty || 1,
                item_rate: row.rate || row.amount,
                item_amount: row.amount,
                units_of_measure: row.uom || "Ea",
                expense_account:
                  frm.doc.default_expense_account || row.expense_account || "",
              });
              total += Math.round(row.amount * 100);
            });

            frm.set_value("invoice_items", invoice_items);
            frm.refresh_field("invoice_items");
            frm.set_value({
              invoice_total_amount: total / 100,
              difference:
                Math.abs(
                  total - Math.round((data.total_amount || 0) * 100)
                ) / 100,
            });

            frappe.show_alert(
              {
                message: __(
                  "Extraction complete — {0} item(s) found.",
                  [invoice_items.length]
                ),
                indicator: "green",
              },
              6
            );
          },
          error(r) {
            frappe.dom.unfreeze();
            $("button[data-fieldname='extract_data']").prop("disabled", false);
            handle_erp_error(r, __("Extraction Error"));
          },
        });
      });

    // -----------------------------------------------
    // GENERATE INVOICE
    // -----------------------------------------------
    $("button[data-fieldname='generate_invoice']")
      .off("click")
      .on("click", () => {
        if ($("button[data-fieldname='generate_invoice']").prop("disabled"))
          return;

        if (!frm.doc.invoice_date) {
          frappe.msgprint({
            title: __("Invoice Date Required"),
            message: __("Please set Invoice Date before generating the invoice."),
            indicator: "orange",
          });
          return;
        }

        if (frm.doc.is_paid && !frm.doc.mode_of_payment) {
          frappe.msgprint({
            title: __("Mode of Payment Required"),
            message: __("Please select a Mode of Payment for a paid invoice."),
            indicator: "orange",
          });
          return;
        }

        if (
          frm.doc.is_paid &&
          frm.doc.invoice_type === "Purchase" &&
          !frm.doc.cash_bank_account
        ) {
          frappe.msgprint({
            title: __("Cash / Bank Account Required"),
            message: __(
              "Please select a Cash/Bank Account for a paid purchase invoice."
            ),
            indicator: "orange",
          });
          return;
        }

        let items = frm.doc.invoice_items || [];
        if (!items.length) {
          frappe.msgprint({
            title: __("No Items"),
            message: __("Please add at least one item before generating the invoice."),
            indicator: "orange",
          });
          return;
        }

        let inv_items = [];
        for (let row of items) {
          if (!row.item_code) {
            frappe.msgprint({
              title: __("Missing Item Code"),
              message: __("All rows in the Items table must have an Item Code."),
              indicator: "orange",
            });
            return;
          }
          if (!row.expense_account && frm.doc.invoice_type === "Purchase") {
            frappe.msgprint({
              title: __("Missing Expense Account"),
              message: __(
                "Expense Account is missing for item: <b>{0}</b>",
                [row.item_code]
              ),
              indicator: "red",
            });
            return;
          }

          let item = {
            item_code: row.item_code,
            qty: row.item_qty || 1,
            description: row.item_description || "",
            rate: row.item_rate || 0,
            amount: (row.item_qty || 1) * (row.item_rate || 0),
          };

          if (frm.doc.invoice_type === "Sales") {
            item.income_account = frm.doc.income_account;
          } else {
            item.expense_account = row.expense_account;
          }

          inv_items.push(item);
        }

        $("button[data-fieldname='generate_invoice']").prop("disabled", true);

        if (frm.doc.invoice_type === "Sales") {
          create_sales_invoice(frm, inv_items);
        } else {
          create_purchase_invoice(frm, inv_items);
        }
      });
  },

  is_paid(frm) {
    toggle_mode_of_payment(frm);
    toggle_cash_bank_account(frm);
  },

  invoice_type(frm) {
    toggle_cash_bank_account(frm);
  },

  mode_of_payment(frm) {
    if (
      frm.doc.is_paid &&
      frm.doc.mode_of_payment &&
      frm.doc.invoice_type === "Purchase"
    ) {
      frappe.call({
        method: "frappe.client.get_value",
        args: {
          doctype: "Mode of Payment Account",
          filters: {
            parent: frm.doc.mode_of_payment,
            company: frm.doc.company,
          },
          fieldname: ["default_account"],
        },
        callback(r) {
          if (r.message?.default_account) {
            frm.set_value("cash_bank_account", r.message.default_account);
          } else {
            frappe.msgprint({
              title: __("Default Account Not Found"),
              message: __(
                'No default Cash/Bank account is configured for <b>{0}</b>. '
                + 'Please configure it in Mode of Payment settings, or select an account manually.',
                [frm.doc.mode_of_payment]
              ),
              indicator: "orange",
            });
          }
        },
      });
    }
  },

  gpt_account(frm) {
    if (!frm.doc.gpt_account) return;
    frappe.db
      .get_value("GPT Setting", frm.doc.gpt_account, "company")
      .then((r) => {
        if (r.message?.company) frm.set_value("company", r.message.company);
      });
  },
});

// -----------------------------------------------
// Error Handler
// ERP server errors (validation, not found, etc.)
// are shown via native frappe.msgprint.
// JS/network errors get a clean fallback message.
// -----------------------------------------------
function handle_erp_error(err, fallback_title) {
  if (err && err._server_messages) {
    try {
      JSON.parse(err._server_messages).forEach((raw) => {
        try {
          frappe.msgprint(JSON.parse(raw));
        } catch (e) {
          frappe.msgprint({
            title: fallback_title,
            message: raw,
            indicator: "red",
          });
        }
      });
    } catch (e) {
      frappe.msgprint({
        title: fallback_title,
        message: String(err._server_messages),
        indicator: "red",
      });
    }
    return;
  }

  if (err && err.exc) {
    const lines = String(err.exc)
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
    frappe.msgprint({
      title: fallback_title || __("Server Error"),
      message: lines[lines.length - 1] || __("An unexpected server error occurred."),
      indicator: "red",
    });
    return;
  }

  frappe.msgprint({
    title: fallback_title || __("Error"),
    message:
      err?.message ||
      err?.statusText ||
      __("An unexpected error occurred. Please check the Error Log for details."),
    indicator: "red",
  });
}

// -----------------------------------------------
// Toggles
// -----------------------------------------------
function toggle_mode_of_payment(frm) {
  frm.toggle_display("mode_of_payment", !!frm.doc.is_paid);
  if (!frm.doc.is_paid && frm.doc.mode_of_payment) {
    frm.set_value("mode_of_payment", "");
  }
}

function toggle_cash_bank_account(frm) {
  let show = frm.doc.is_paid && frm.doc.invoice_type === "Purchase";
  frm.toggle_display("cash_bank_account", show);
  if (!show && frm.doc.cash_bank_account) {
    frm.set_value("cash_bank_account", "");
  }
}

// -----------------------------------------------
// File Attachment
// -----------------------------------------------
function attach_file(frm, doctype, docname) {
  if (!frm.doc.invoice_file) return Promise.resolve();
  return frappe.db
    .insert({
      doctype: "File",
      is_private: 1,
      file_url: frm.doc.invoice_file,
      attached_to_doctype: doctype,
      attached_to_name: docname,
    })
    .catch(() => {});
}

// -----------------------------------------------
// Sales Invoice Creation
// -----------------------------------------------
function create_sales_invoice(frm, inv_items) {
  frappe.dom.freeze(__("Creating Sales Invoice — please wait..."));

  frappe.db
    .get_doc("Customer", frm.doc.customer_name)
    .then((customer_doc) => {
      let company_name = frm.doc.company;
      if (customer_doc.accounts?.length) {
        company_name = customer_doc.accounts[0].company;
      }

      let doc = {
        doctype: "Sales Invoice",
        customer: frm.doc.customer_name,
        posting_date: frm.doc.invoice_date,
        company: company_name,
        currency: frm.doc.currency,
        items: inv_items,
      };

      if (frm.doc.is_paid) {
        doc.is_paid = 1;
        doc.payments = [
          {
            mode_of_payment: frm.doc.mode_of_payment,
            amount: frm.doc.invoice_total_amount,
          },
        ];
      }

      return frappe.db.insert(doc);
    })
    .then((res) => {
      frm.set_value("generated_sales", res.name);
      return attach_file(frm, "Sales Invoice", res.name).then(() => res);
    })
    .then((res) => frm.save().then(() => res))
    .then((res) => {
      frappe.dom.unfreeze();
      frappe.show_alert(
        {
          message: __(
            "Sales Invoice {0} created successfully{1}",
            [
              `<a href="/app/sales-invoice/${res.name}" target="_blank">${res.name}</a>`,
              frm.doc.is_paid ? " &mdash; " + __("Paid") : "",
            ]
          ),
          indicator: "green",
        },
        8
      );
    })
    .catch((err) => {
      frappe.dom.unfreeze();
      handle_erp_error(err, __("Sales Invoice Creation Failed"));
    })
    .finally(() => {
      $("button[data-fieldname='generate_invoice']").prop("disabled", false);
    });
}

// -----------------------------------------------
// Purchase Invoice Creation
// -----------------------------------------------
function create_purchase_invoice(frm, inv_items) {
  frappe.dom.freeze(__("Creating Purchase Invoice — please wait..."));

  frappe.db
    .get_doc("Supplier", frm.doc.supplier_name)
    .then((supplier_doc) => {
      let company_name = frm.doc.company;
      if (supplier_doc.accounts?.length) {
        company_name = supplier_doc.accounts[0].company;
      }

      let doc = {
        doctype: "Purchase Invoice",
        supplier: frm.doc.supplier_name,
        posting_date: frm.doc.invoice_date,
        bill_no: frm.doc.supplier_invoice_no || "",
        bill_date: frm.doc.supplier_invoice_date || frm.doc.invoice_date,
        company: company_name,
        currency: frm.doc.currency,
        items: inv_items,
      };

      if (frm.doc.is_paid) {
        doc.is_paid = 1;
        doc.mode_of_payment = frm.doc.mode_of_payment;
        doc.cash_bank_account = frm.doc.cash_bank_account;
      }

      return frappe.call({
        method: "frappe.client.insert",
        args: { doc },
      });
    })
    .then((r) => {
      if (!r?.message) throw new Error(__("No response from server."));
      frm.set_value("generated_purchase", r.message.name);
      return attach_file(frm, "Purchase Invoice", r.message.name).then(
        () => r.message
      );
    })
    .then((doc) => frm.save().then(() => doc))
    .then((doc) => {
      frappe.dom.unfreeze();
      frappe.show_alert(
        {
          message: __(
            "Purchase Invoice {0} created successfully{1}",
            [
              `<a href="/app/purchase-invoice/${doc.name}" target="_blank">${doc.name}</a>`,
              frm.doc.is_paid ? " &mdash; " + __("Paid") : "",
            ]
          ),
          indicator: "green",
        },
        8
      );
    })
    .catch((err) => {
      frappe.dom.unfreeze();
      handle_erp_error(err, __("Purchase Invoice Creation Failed"));
    })
    .finally(() => {
      $("button[data-fieldname='generate_invoice']").prop("disabled", false);
    });
}

// -----------------------------------------------
// Item Table Recalculation
// -----------------------------------------------
frappe.ui.form.on("Invoice Import Tool Item", {
  item_qty(frm) {
    recalc_items(frm);
  },
  item_rate(frm) {
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
