frappe.ui.form.on("Cvs Invoice Tool", {
  refresh(frm) {
    frm.set_df_property("generated_sales", "read_only", 1);
    frm.set_df_property("generated_purchase", "read_only", 1);

    frm.set_query("mode_of_payment", () => ({
      query:
        "ipconnex_ai_invoice.ipconnex_ai_invoice.doctype.cvs_invoice_tool.cvs_invoice_tool.get_mode_of_payment_query",
      filters: { company: frm.doc.company },
    }));

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
                // Default Item (if set) takes priority over an AI-extracted item_code
                item_code:
                  frm.doc.invoice_default_item || row.item_code || "",
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

            if (frm.doc.invoice_type === "Purchase") {
              apply_extracted_taxes(frm, data.taxes || []);
              apply_extracted_discount(frm, data, total);
            }

            recalc_taxes_and_totals(frm);

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

        if (!frm.doc.invoice_type) {
          frappe.msgprint({
            title: __("Invoice Type Required"),
            message: __("Please select an Invoice Type (Purchase or Sales)."),
            indicator: "orange",
          });
          return;
        }

        if (frm.doc.invoice_type === "Purchase" && !frm.doc.supplier_name) {
          frappe.msgprint({
            title: __("Supplier Required"),
            message: __("Please select a Supplier before generating a Purchase Invoice."),
            indicator: "orange",
          });
          return;
        }

        if (frm.doc.invoice_type === "Sales" && !frm.doc.customer_name) {
          frappe.msgprint({
            title: __("Customer Required"),
            message: __("Please select a Customer before generating a Sales Invoice."),
            indicator: "orange",
          });
          return;
        }

        if (frm.doc.invoice_type === "Sales" && !frm.doc.income_account) {
          frappe.msgprint({
            title: __("Income Account Required"),
            message: __("Please set an Income Account before generating a Sales Invoice."),
            indicator: "red",
          });
          return;
        }

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

        if (frm.doc.invoice_type === "Purchase") {
          for (let row of frm.doc.invoice_taxes || []) {
            if (!row.account_head) {
              frappe.msgprint({
                title: __("Missing Tax Account"),
                message: __(
                  "Please set an Account Head for the tax row: <b>{0}</b>",
                  [row.description || row.idx]
                ),
                indicator: "red",
              });
              return;
            }
          }
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
    recalc_taxes_and_totals(frm);
  },

  mode_of_payment(frm) {
    fetch_cash_bank_account(frm);
  },

  company(frm) {
    handle_company_change_for_mode_of_payment(frm);
    fetch_default_expense_account(frm);
  },

  invoice_default_item(frm) {
    fetch_default_expense_account(frm);
  },

  apply_discount_on(frm) {
    recalc_taxes_and_totals(frm);
  },

  additional_discount_percentage(frm) {
    frm.doc.__discount_from_percentage = true;
    recalc_taxes_and_totals(frm);
  },

  discount_amount(frm) {
    frm.doc.__discount_from_percentage = false;
    recalc_taxes_and_totals(frm);
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
// Company changed: clear Mode of Payment (and its Cash/Bank Account)
// if it has no Mode of Payment Account row for the new Company.
// -----------------------------------------------
function handle_company_change_for_mode_of_payment(frm) {
  if (!frm.doc.mode_of_payment) {
    return;
  }

  if (!frm.doc.company) {
    frm.set_value("mode_of_payment", "");
    frm.set_value("cash_bank_account", "");
    return;
  }

  frappe.call({
    method:
      "ipconnex_ai_invoice.ipconnex_ai_invoice.doctype.cvs_invoice_tool.cvs_invoice_tool.is_mode_of_payment_valid_for_company",
    args: {
      mode_of_payment: frm.doc.mode_of_payment,
      company: frm.doc.company,
    },
    callback(r) {
      if (r.message?.valid) {
        fetch_cash_bank_account(frm);
      } else {
        frm.set_value("mode_of_payment", "");
        frm.set_value("cash_bank_account", "");
      }
    },
  });
}

// -----------------------------------------------
// Auto-fetch: Cash/Bank Account from Mode of Payment + Company
// -----------------------------------------------
function fetch_cash_bank_account(frm) {
  if (
    !frm.doc.is_paid ||
    !frm.doc.mode_of_payment ||
    !frm.doc.company ||
    frm.doc.invoice_type !== "Purchase"
  ) {
    return;
  }

  frappe.call({
    method: "frappe.client.get_value",
    args: {
      doctype: "Mode of Payment Account",
      // "parent" here is the parent DOCTYPE (for frappe.client.get_value's own
      // permission check on this child table) — not to be confused with
      // filters.parent below, which is the specific Mode of Payment record.
      parent: "Mode of Payment",
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
        frm.set_value("cash_bank_account", "");
        frappe.msgprint({
          title: __("Default Account Not Found"),
          message: __(
            'No default Cash/Bank account is configured for <b>{0}</b> in company <b>{1}</b>. '
            + 'Please configure it in Mode of Payment settings, or select an account manually.',
            [frm.doc.mode_of_payment, frm.doc.company]
          ),
          indicator: "orange",
        });
      }
    },
  });
}

// -----------------------------------------------
// Auto-fetch: Default Expense Account from Item/Item Group/Company defaults
// -----------------------------------------------
function fetch_default_expense_account(frm) {
  if (
    !frm.doc.invoice_default_item ||
    !frm.doc.company ||
    frm.doc.invoice_type !== "Purchase"
  ) {
    return;
  }

  frappe.call({
    method:
      "ipconnex_ai_invoice.ipconnex_ai_invoice.doctype.cvs_invoice_tool.cvs_invoice_tool.get_expense_account",
    args: {
      item_code: frm.doc.invoice_default_item,
      company: frm.doc.company,
    },
    callback(r) {
      if (r.message?.expense_account) {
        frm.set_value("default_expense_account", r.message.expense_account);
      } else {
        frm.set_value("default_expense_account", "");
        frappe.show_alert(
          {
            message: __(
              "No default Expense Account found for item {0} in company {1}. Please select one manually.",
              [frm.doc.invoice_default_item, frm.doc.company]
            ),
            indicator: "orange",
          },
          6
        );
      }
    },
  });
}

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
// Extracted Taxes -> Taxes and Charges table
// -----------------------------------------------
function apply_extracted_taxes(frm, taxes) {
  let rows = (taxes || []).filter((t) => t.tax_amount && t.tax_amount > 0);

  if (!rows.length) {
    frm.set_value("invoice_taxes", []);
    frm.refresh_field("invoice_taxes");
    return;
  }

  let invoice_taxes = rows.map((t) => ({
    add_deduct_tax: "Add",
    type: "Actual",
    description: t.description || __("Tax"),
    tax_amount: t.tax_amount,
    rate: t.tax_rate || 0,
    account_head: "",
  }));

  frm.set_value("invoice_taxes", invoice_taxes);
  frm.refresh_field("invoice_taxes");

  if (!frm.doc.company) return;

  frappe.call({
    method:
      "ipconnex_ai_invoice.ipconnex_ai_invoice.doctype.cvs_invoice_tool.cvs_invoice_tool.get_default_tax_account",
    args: { company: frm.doc.company },
    callback(r) {
      let account_head = r.message?.account_head;
      if (!account_head) {
        frappe.show_alert(
          {
            message: __(
              "No default Tax Account configured for company {0}. Please set an Account Head for each tax row manually.",
              [frm.doc.company]
            ),
            indicator: "orange",
          },
          8
        );
        return;
      }
      (frm.doc.invoice_taxes || []).forEach((row) => {
        if (!row.account_head) {
          frappe.model.set_value(row.doctype, row.name, "account_head", account_head);
        }
      });
    },
  });
}

// -----------------------------------------------
// Extracted Discount -> Additional Discount Percentage
// Resolves to a percentage either way, using the recomputed item total
// (the reliable pre-discount base) so we never double count discounts
// already baked into individual item rates.
// -----------------------------------------------
function apply_extracted_discount(frm, data, items_total_cents) {
  let base = (items_total_cents || 0) / 100;
  if (!base && data.subtotal) base = data.subtotal;

  let pct = 0;
  if (data.discount_percentage && data.discount_percentage > 0) {
    pct = data.discount_percentage;
  } else if (data.discount_amount && data.discount_amount > 0 && base > 0) {
    pct = (data.discount_amount / base) * 100;
  }

  if (pct > 0) {
    frm.set_value("apply_discount_on", "Net Total");
    frm.set_value("additional_discount_percentage", Math.round(pct * 10000) / 10000);
  } else {
    frm.set_value("additional_discount_percentage", 0);
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

  let si_company = frm.doc.company;

  frappe.db
    .get_doc("Customer", frm.doc.customer_name)
    .then((_customer_doc) => {
      let doc = {
        doctype: "Sales Invoice",
        customer: frm.doc.customer_name,
        posting_date: frm.doc.invoice_date,
        company: si_company,
        currency: frm.doc.currency,
        income_account: frm.doc.income_account,
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

  let company_name = frm.doc.company;

  frappe.db
    .get_doc("Supplier", frm.doc.supplier_name)
    .then((supplier_doc) => {
      // Resolve credit_to from supplier's accounts child table for this company
      let credit_to = "";
      if (supplier_doc.accounts && supplier_doc.accounts.length) {
        let match = supplier_doc.accounts.find((a) => a.company === company_name);
        if (match) credit_to = match.account;
      }
      if (credit_to) return credit_to;

      // Fall back to Company's default payable account
      return frappe.db
        .get_value("Company", company_name, "default_payable_account")
        .then((r) => r?.message?.default_payable_account || "");
    })
    .then((credit_to) => {
      let doc = {
        doctype: "Purchase Invoice",
        supplier: frm.doc.supplier_name,
        posting_date: frm.doc.supplier_invoice_date || frm.doc.invoice_date,
        bill_no: frm.doc.supplier_invoice_no || "",
        bill_date: frm.doc.supplier_invoice_date || frm.doc.invoice_date,
        company: company_name,
        currency: frm.doc.currency,
        items: inv_items,
      };

      if (credit_to) doc.credit_to = credit_to;

      if (frm.doc.is_paid) {
        doc.is_paid = 1;
        doc.mode_of_payment = frm.doc.mode_of_payment;
        doc.cash_bank_account = frm.doc.cash_bank_account;
      }

      if ((frm.doc.invoice_taxes || []).length) {
        doc.taxes = frm.doc.invoice_taxes.map((row) => ({
          add_deduct_tax: row.add_deduct_tax || "Add",
          charge_type: row.type || "Actual",
          account_head: row.account_head,
          description: row.description || __("Tax"),
          rate: row.rate || 0,
          tax_amount: row.tax_amount || 0,
        }));
      }

      if (frm.doc.additional_discount_percentage || frm.doc.discount_amount) {
        doc.apply_discount_on = frm.doc.apply_discount_on || "Net Total";
        doc.additional_discount_percentage = frm.doc.additional_discount_percentage || 0;
        doc.discount_amount = frm.doc.discount_amount || 0;
      }

      // Wrap frappe.call in a native Promise to preserve .finally() on the chain
      return new Promise((resolve, reject) => {
        frappe.call({
          method: "frappe.client.insert",
          args: { doc },
          callback: (r) => {
            if (r?.message) resolve(r);
            else reject(new Error(__("No response from server.")));
          },
          error: reject,
        });
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
  item_code(frm, cdt, cdn) {
    let row = frappe.get_doc(cdt, cdn);
    if (
      !row.item_code ||
      row.expense_account ||
      !frm.doc.company ||
      frm.doc.invoice_type !== "Purchase"
    ) {
      return;
    }
    frappe.call({
      method:
        "ipconnex_ai_invoice.ipconnex_ai_invoice.doctype.cvs_invoice_tool.cvs_invoice_tool.get_expense_account",
      args: {
        item_code: row.item_code,
        company: frm.doc.company,
      },
      callback(r) {
        if (r.message?.expense_account) {
          frappe.model.set_value(cdt, cdn, "expense_account", r.message.expense_account);
        }
      },
    });
  },
});

function recalc_items(frm) {
  setTimeout(() => {
    (frm.doc.invoice_items || []).forEach((row) => {
      row.item_amount = (row.item_rate || 0) * (row.item_qty || 1);
    });
    frm.refresh_field("invoice_items");
    recalc_taxes_and_totals(frm);
  }, 200);
}

// -----------------------------------------------
// Taxes and Charges table + discount events
// (mirrors ERPNext's own tax/discount calculation)
// -----------------------------------------------
frappe.ui.form.on("Invoice Import Tool Tax", {
  add_deduct_tax(frm) {
    recalc_taxes_and_totals(frm);
  },
  type(frm) {
    recalc_taxes_and_totals(frm);
  },
  rate(frm) {
    recalc_taxes_and_totals(frm);
  },
  tax_amount(frm) {
    recalc_taxes_and_totals(frm);
  },
  invoice_taxes_add(frm, cdt, cdn) {
    let row = frappe.get_doc(cdt, cdn);
    if (!row.add_deduct_tax) row.add_deduct_tax = "Add";
    if (!row.type) row.type = "On Net Total";
  },
  invoice_taxes_remove(frm) {
    recalc_taxes_and_totals(frm);
  },
});

function recalc_taxes_and_totals(frm) {
  if (frm.doc.invoice_type !== "Purchase") {
    let total = 0;
    (frm.doc.invoice_items || []).forEach((row) => {
      total += flt(row.item_amount);
    });
    frm.set_value("invoice_total_amount", flt(total));
    frm.set_value(
      "difference",
      Math.abs(flt(total) - flt(frm.doc.extracted_amount))
    );
    return;
  }

  let net_total = 0;
  (frm.doc.invoice_items || []).forEach((row) => {
    net_total += flt(row.item_amount);
  });
  net_total = flt(net_total);

  let taxes = frm.doc.invoice_taxes || [];
  let running_total = net_total;
  let added = 0;
  let deducted = 0;

  taxes.forEach((row, i) => {
    let tax_amount = 0;
    let prev = i > 0 ? taxes[i - 1] : null;

    if (row.type === "On Net Total") {
      tax_amount = (net_total * flt(row.rate)) / 100;
    } else if (row.type === "On Previous Row Amount" && prev) {
      tax_amount = (flt(prev.tax_amount) * flt(row.rate)) / 100;
    } else if (row.type === "On Previous Row Total" && prev) {
      tax_amount = (flt(prev.total) * flt(row.rate)) / 100;
    } else {
      // "Actual" (or a reference row with nothing to compute from yet): keep the manually entered amount
      tax_amount = flt(row.tax_amount);
    }

    tax_amount = flt(tax_amount);
    row.tax_amount = tax_amount;

    if (row.add_deduct_tax === "Deduct") {
      running_total -= tax_amount;
      deducted += tax_amount;
    } else {
      running_total += tax_amount;
      added += tax_amount;
    }
    row.total = flt(running_total);
  });

  frm.refresh_field("invoice_taxes");
  frm.set_value("net_total", net_total);
  frm.set_value("taxes_and_charges_added", flt(added));
  frm.set_value("taxes_and_charges_deducted", flt(deducted));
  frm.set_value("total_taxes_and_charges", flt(added - deducted));

  let discount_base =
    frm.doc.apply_discount_on === "Grand Total" ? running_total : net_total;

  let discount_amount = flt(frm.doc.discount_amount);
  if (frm.doc.__discount_from_percentage !== false && frm.doc.additional_discount_percentage) {
    discount_amount = flt((discount_base * flt(frm.doc.additional_discount_percentage)) / 100);
  }

  let grand_total =
    frm.doc.apply_discount_on === "Grand Total"
      ? running_total - discount_amount
      : net_total - discount_amount + (added - deducted);

  grand_total = flt(grand_total);

  frm.set_value("discount_amount", discount_amount);
  frm.set_value("invoice_total_amount", grand_total);
  frm.set_value(
    "difference",
    Math.abs(grand_total - flt(frm.doc.extracted_amount))
  );
}
