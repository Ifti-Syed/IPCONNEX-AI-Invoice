console.log("🔥 Invoice Import Tool JS LOADED v1440 - WITH LOADING DIALOGS 🔥");

var scriptElement = document.createElement("script");
scriptElement.src =
  "https://cdn.jsdelivr.net/npm/sweetalert2@11/dist/sweetalert2.all.min.js";
document.head.appendChild(scriptElement);

frappe.ui.form.on("Invoice Import Tool", {
  refresh(frm) {
    $("input[data-fieldname='generated_sales']").prop("readonly", true);
    $("input[data-fieldname='generated_purchase']").prop("readonly", true);

    toggle_mode_of_payment(frm);
    toggle_cash_bank_account(frm);

    // -------------------------------
    // EXTRACT DATA
    // -------------------------------
    $("button[data-fieldname='extract_data']")
      .off("click")
      .on("click", () => {
        if ($("button[data-fieldname='extract_data']").prop("disabled")) return;

        $("button[data-fieldname='extract_data']").prop("disabled", true);

        let field_empty = false;

        if (!frm.doc.gpt_account) {
          $("input[data-fieldname='gpt_account']").css({
            "border-color": "red",
            "border-width": "1px",
            "border-style": "solid",
          });
          field_empty = true;
        }

        if (!frm.doc.invoice_file) {
          $("div[data-fieldname='invoice_file']")
            .find("div[class='control-input']")
            .css({
              "border-color": "red",
              "border-width": "1px",
              "border-style": "solid",
            });
          field_empty = true;
        }

        if (field_empty) {
          Swal.fire({
            icon: "warning",
            title: "Empty fields!",
            text: "Please fill empty fields first",
          });

          $("button[data-fieldname='extract_data']").prop("disabled", false);
          return;
        }

        // Show loading dialog
        Swal.fire({
          title: 'Extracting Invoice Data',
          html: `
            <div style="padding: 20px;">
              <div class="spinner-border text-primary" role="status" style="width: 3rem; height: 3rem;">
                <span class="sr-only">Loading...</span>
              </div>
              <p style="margin-top: 20px; color: #6c757d;">
                <i class="fa fa-file-pdf" style="font-size: 24px; color: #dc3545;"></i><br/>
                Processing invoice with AI...<br/>
                <small>This may take a few moments</small>
              </p>
              <div style="margin-top: 15px;">
                <div class="progress" style="height: 6px;">
                  <div class="progress-bar progress-bar-striped progress-bar-animated" 
                       role="progressbar" 
                       style="width: 100%">
                  </div>
                </div>
              </div>
            </div>
          `,
          allowOutsideClick: false,
          allowEscapeKey: false,
          showConfirmButton: false,
          didOpen: () => {
            Swal.showLoading();
          }
        });

        frappe.call({
          method:
            "ipconnex_ai_invoice.ipconnex_ai_invoice.extract.extract_invoice_with_vision",
          args: {
            pdf_path: frm.doc.invoice_file,
            company_doctype: "Company",
            account_name: frm.doc.gpt_account,
          },
          callback(r) {
            $("button[data-fieldname='extract_data']").prop("disabled", false);
            
            // Close loading dialog
            Swal.close();

            if (!r.message || r.message.status !== 1) {
              Swal.fire({
                icon: "error",
                title: "Extraction Failed",
                text: r.message?.error || "Unknown error",
              });
              return;
            }

            const data = r.message.data;
            console.log("✅ Extracted Invoice Data:", data);

            if (frm.doc.invoice_type === "Purchase") {
              frm.set_value("supplier_name", data.supplier || "");
            }

            if (frm.doc.invoice_type === "Sales") {
              frm.set_value("customer_name", data.company || "");
            }

            frm.set_value("invoice_date", data.bill_date || "");
            frm.set_value("currency", data.currency || frm.doc.currency);
            frm.set_value("extracted_amount", data.total_amount || 0);

            // Items
            let items = data.items || [];
            let invoice_items = [];
            let total = 0;

            items.forEach((row) => {
              if (!row.amount || row.amount <= 0) return;

              invoice_items.push({
                item_code:
                  frm.doc.invoice_default_item ||
                  row.item_code ||
                  "99-Purchases",
                item_description:
                  row.item_description || row.item_name || "Auto-imported item",
                item_qty: row.qty || 1,
                item_rate: row.rate || row.amount,
                item_amount: row.amount,
                units_of_measure: row.uom || "Ea",
                expense_account:
                  frm.doc.default_expense_account ||
                  row.expense_account ||
                  "Accounts Receivable - CVS",
              });

              total += Math.round(row.amount * 100);
            });

            frm.set_value("invoice_items", invoice_items);
            frm.refresh_field("invoice_items");

            frm.set_value({
              invoice_total_amount: total / 100,
              difference:
                Math.abs(total - Math.round((data.total_amount || 0) * 100)) /
                100,
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
    // GENERATE INVOICE
    // -------------------------------
    $("button[data-fieldname='generate_invoice']")
      .off("click")
      .on("click", async () => {
        if ($("button[data-fieldname='generate_invoice']").prop("disabled"))
          return;

        // Validations
        if (!frm.doc.invoice_date) {
          Swal.fire({
            icon: "warning",
            title: "Missing Invoice Date",
            text: "Please set Invoice Date before generating invoice",
          });
          return;
        }

        if (frm.doc.is_paid && !frm.doc.mode_of_payment) {
          Swal.fire({
            icon: "warning",
            title: "Mode of Payment Required",
            text: "Please select Mode of Payment for paid invoice",
          });
          return;
        }

        // Validate Cash/Bank Account for Purchase Invoice when paid
        if (
          frm.doc.is_paid &&
          frm.doc.invoice_type === "Purchase" &&
          !frm.doc.cash_bank_account
        ) {
          Swal.fire({
            icon: "warning",
            title: "Cash/Bank Account Required",
            text: "Please select Cash/Bank Account for paid purchase invoice",
          });
          return;
        }

        // Build items
        let items = frm.doc.invoice_items || [];
        if (!items.length) {
          Swal.fire({
            icon: "warning",
            title: "No Items",
            text: "Please add items before generating invoice",
          });
          return;
        }

        let inv_items = [];

        for (let row of items) {
          if (!row.item_code) {
            Swal.fire({
              icon: "warning",
              title: "Missing Item Code",
              text: "Please fill item codes first",
            });
            return;
          }

          if (!row.expense_account && frm.doc.invoice_type === "Purchase") {
            Swal.fire({
              icon: "error",
              title: "Missing Expense Account",
              text: `Expense Account is missing for item: ${row.item_code}`,
            });
            return;
          }

          let item = {
            item_code: row.item_code,
            qty: row.item_qty || 1,
            description: row.item_description || "Auto-imported item",
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
    // Auto-fetch cash/bank account for Purchase invoices
    if (
      frm.doc.is_paid &&
      frm.doc.mode_of_payment &&
      frm.doc.invoice_type === "Purchase"
    ) {
      console.log("🔍 Fetching cash/bank account for:", frm.doc.mode_of_payment);

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
        callback: function (r) {
          if (r.message && r.message.default_account) {
            frm.set_value("cash_bank_account", r.message.default_account);
            console.log("✅ Auto-filled cash/bank account:", r.message.default_account);
          } else {
            console.log("⚠️ No default account found");
            frappe.msgprint({
              title: "Account Not Found",
              message: `Please configure a default account for "${frm.doc.mode_of_payment}" in Mode of Payment settings, or select an account manually.`,
              indicator: "orange",
            });
          }
        }
      });
    }
  },

  gpt_account(frm) {
    if (!frm.doc.gpt_account) return;
    frappe.db.get_value("GPT Setting", frm.doc.gpt_account, "company").then((r) => {
      if (r.message?.company) frm.set_value("company", r.message.company);
    });
  },
});

// ---------------------------------
// Helper Functions
// ---------------------------------
function toggle_mode_of_payment(frm) {
  frm.toggle_display("mode_of_payment", !!frm.doc.is_paid);
  if (!frm.doc.is_paid && frm.doc.mode_of_payment) {
    frm.set_value("mode_of_payment", "");
  }
}

function toggle_cash_bank_account(frm) {
  let should_show = frm.doc.is_paid && frm.doc.invoice_type === "Purchase";
  frm.toggle_display("cash_bank_account", should_show);

  if (!should_show && frm.doc.cash_bank_account) {
    frm.set_value("cash_bank_account", "");
  }
}

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
    .catch((err) => {
      console.warn("⚠️ File attachment failed:", err);
    });
}

// ---------------------------------
// SALES INVOICE CREATION
// ---------------------------------
function create_sales_invoice(frm, inv_items) {
  console.log("📝 Creating Sales Invoice...");
  
  // Show loading dialog
  Swal.fire({
    title: 'Creating Sales Invoice',
    html: `
      <div style="padding: 20px;">
        <div class="spinner-border text-success" role="status" style="width: 3rem; height: 3rem;">
          <span class="sr-only">Loading...</span>
        </div>
        <p style="margin-top: 20px; color: #6c757d;">
          <i class="fa fa-file-invoice" style="font-size: 24px; color: #28a745;"></i><br/>
          Generating sales invoice...<br/>
          <small>Please wait</small>
        </p>
      </div>
    `,
    allowOutsideClick: false,
    allowEscapeKey: false,
    showConfirmButton: false,
    didOpen: () => {
      Swal.showLoading();
    }
  });
  
  let company_name = frm.doc.company;

  frappe.db
    .get_doc("Customer", frm.doc.customer_name)
    .then((customer_doc) => {
      if (customer_doc.accounts?.length) {
        company_name = customer_doc.accounts[0].company;
      }

      let sales_invoice = {
        doctype: "Sales Invoice",
        customer: frm.doc.customer_name,
        posting_date: frm.doc.invoice_date,
        company: company_name,
        currency: frm.doc.currency,
        items: inv_items,
      };

      // ✅ Sales Invoice payment structure
      if (frm.doc.is_paid) {
        sales_invoice.is_paid = 1;
        sales_invoice.payments = [
          {
            mode_of_payment: frm.doc.mode_of_payment,
            amount: frm.doc.invoice_total_amount,
          },
        ];
        console.log("💰 Payment added:", sales_invoice.payments);
      }

      console.log("📋 Sales Invoice Data:", sales_invoice);
      return frappe.db.insert(sales_invoice);
    })
    .then((res) => {
      console.log("✅ Sales Invoice created:", res.name);
      frm.set_value("generated_sales", res.name);
      return attach_file(frm, "Sales Invoice", res.name).then(() => res);
    })
    .then(() => frm.save())
    .then(() => {
      Swal.fire({
        icon: "success",
        title: "Success!",
        text: `Sales Invoice created successfully! ${frm.doc.is_paid ? "(Paid)" : "(Unpaid)"}`,
      });
    })
    .catch((err) => {
      console.error("❌ Sales invoice error:", err);
      const errorDetails = extract_erp_error(err);
      
      Swal.fire({
        icon: "error",
        title: "Sales Invoice Failed",
        html: `<div style="text-align: left; max-height: 400px; overflow-y: auto;">
                <strong>Error Message:</strong><br/>
                <div style="background: #f8f9fa; padding: 10px; border-radius: 4px; margin: 10px 0; font-family: monospace; font-size: 12px; white-space: pre-wrap;">${errorDetails.message}</div>
                ${errorDetails.title ? `<strong>Error Type:</strong> ${errorDetails.title}<br/>` : ''}
                ${errorDetails.indicator ? `<strong>Indicator:</strong> ${errorDetails.indicator}<br/>` : ''}
                <small style="color: #6c757d;">Check browser console (F12) for full error details</small>
              </div>`,
        width: 600,
      });
    })
    .finally(() => {
      $("button[data-fieldname='generate_invoice']").prop("disabled", false);
    });
}

// ---------------------------------
// PURCHASE INVOICE CREATION
// ---------------------------------
function create_purchase_invoice(frm, inv_items) {
  console.log("📝 Creating Purchase Invoice...");
  
  // Show loading dialog
  Swal.fire({
    title: 'Creating Purchase Invoice',
    html: `
      <div style="padding: 20px;">
        <div class="spinner-border text-primary" role="status" style="width: 3rem; height: 3rem;">
          <span class="sr-only">Loading...</span>
        </div>
        <p style="margin-top: 20px; color: #6c757d;">
          <i class="fa fa-shopping-cart" style="font-size: 24px; color: #007bff;"></i><br/>
          Generating purchase invoice...<br/>
          <small>Please wait</small>
        </p>
      </div>
    `,
    allowOutsideClick: false,
    allowEscapeKey: false,
    showConfirmButton: false,
    didOpen: () => {
      Swal.showLoading();
    }
  });
  
  let company_name = frm.doc.company;

  frappe.db
    .get_doc("Supplier", frm.doc.supplier_name)
    .then((supplier_doc) => {
      if (supplier_doc.accounts?.length) {
        company_name = supplier_doc.accounts[0].company;
      }

      let purchase_invoice = {
        doctype: "Purchase Invoice",
        supplier: frm.doc.supplier_name,
        posting_date: frm.doc.invoice_date,
        company: company_name,
        currency: frm.doc.currency,
        items: inv_items,
      };

      // ✅ Purchase Invoice payment structure (direct fields, NOT payments array)
      if (frm.doc.is_paid) {
        purchase_invoice.is_paid = 1;
        purchase_invoice.mode_of_payment = frm.doc.mode_of_payment;
        purchase_invoice.cash_bank_account = frm.doc.cash_bank_account;
        
        console.log("💰 Payment info:", {
          is_paid: 1,
          mode_of_payment: frm.doc.mode_of_payment,
          cash_bank_account: frm.doc.cash_bank_account
        });
      }

      console.log("📋 Purchase Invoice Data:", JSON.stringify(purchase_invoice, null, 2));

      return frappe.call({
        method: "frappe.client.insert",
        args: { doc: purchase_invoice },
      });
    })
    .then((r) => {
      if (!r || !r.message) {
        throw new Error("No response from server");
      }
      
      console.log("✅ Purchase Invoice created:", r.message.name);
      frm.set_value("generated_purchase", r.message.name);
      return attach_file(frm, "Purchase Invoice", r.message.name);
    })
    .then(() => frm.save())
    .then(() => {
      Swal.fire({
        icon: "success",
        title: "Success!",
        text: `Purchase Invoice created successfully! ${frm.doc.is_paid ? "(Paid)" : "(Unpaid)"}`,
      });
    })
    .catch((err) => {
      console.error("❌ Purchase invoice error:", err);
      const errorDetails = extract_erp_error(err);
      
      Swal.fire({
        icon: "error",
        title: "Purchase Invoice Failed",
        html: `<div style="text-align: left; max-height: 400px; overflow-y: auto;">
                <strong>Error Message:</strong><br/>
                <div style="background: #f8f9fa; padding: 10px; border-radius: 4px; margin: 10px 0; font-family: monospace; font-size: 12px; white-space: pre-wrap;">${errorDetails.message}</div>
                ${errorDetails.title ? `<strong>Error Type:</strong> ${errorDetails.title}<br/>` : ''}
                ${errorDetails.indicator ? `<strong>Indicator:</strong> ${errorDetails.indicator}<br/>` : ''}
                <small style="color: #6c757d;">Check browser console (F12) for full error details</small>
              </div>`,
        width: 600,
      });
    })
    .finally(() => {
      $("button[data-fieldname='generate_invoice']").prop("disabled", false);
    });
}

// ---------------------------------
// ✅ IMPROVED ERROR EXTRACTION FROM ERP
// ---------------------------------
function extract_erp_error(err) {
  console.log("🔍 Extracting error from:", err);
  
  let result = {
    message: "An unknown error occurred",
    title: null,
    indicator: null
  };

  // Priority 1: _server_messages (most reliable for ERPNext errors)
  if (err && err._server_messages) {
    try {
      const messages = JSON.parse(err._server_messages);
      if (Array.isArray(messages) && messages.length > 0) {
        const parsed_messages = messages.map(msg => {
          try {
            const parsed = JSON.parse(msg);
            result.title = parsed.title || result.title;
            result.indicator = parsed.indicator || result.indicator;
            return parsed.message || msg;
          } catch (e) {
            return msg;
          }
        }).filter(Boolean);
        
        if (parsed_messages.length > 0) {
          result.message = parsed_messages.join('\n');
          console.log("✅ Found error in _server_messages:", result.message);
          return result;
        }
      }
    } catch (e) {
      console.error("Failed to parse _server_messages:", e);
    }
  }

  // Priority 2: exc field (Python exceptions)
  if (err && err.exc) {
    try {
      const exc = JSON.parse(err.exc);
      if (Array.isArray(exc) && exc.length > 0) {
        result.message = exc.join('\n');
        console.log("✅ Found error in exc:", result.message);
        return result;
      }
    } catch (e) {
      // If not JSON, use as-is
      result.message = String(err.exc);
      console.log("✅ Found error in exc (raw):", result.message);
      return result;
    }
  }

  // Priority 3: message field
  if (err && err.message) {
    result.message = String(err.message);
    console.log("✅ Found error in message:", result.message);
    return result;
  }

  // Priority 4: Extract from HTML response (500 errors)
  if (err && err.responseText) {
    try {
      // Try to find error in HTML
      const parser = new DOMParser();
      const doc = parser.parseFromString(err.responseText, 'text/html');
      
      // Look for common ERPNext error containers
      const errorSelectors = [
        'pre',
        '.msgprint',
        '.error-message',
        '.indicator-pill',
        'body'
      ];
      
      for (const selector of errorSelectors) {
        const element = doc.querySelector(selector);
        if (element) {
          let text = element.textContent.trim();
          // Clean up the text
          text = text
            .replace(/\s+/g, ' ')
            .replace(/^\s*Error\s*/i, '')
            .trim();
          
          if (text.length > 0 && text.length < 2000) {
            result.message = text;
            console.log(`✅ Found error in HTML (${selector}):`, result.message);
            return result;
          }
        }
      }
    } catch (e) {
      console.error("Failed to parse HTML response:", e);
    }
  }

  // Priority 5: statusText
  if (err && err.statusText) {
    result.message = `Server Error: ${err.statusText}`;
  }

  // Last resort
  if (result.message === "An unknown error occurred") {
    result.message = "Server error occurred. Please check ERPNext Error Log for details.";
  }

  console.log("⚠️ Final error result:", result);
  return result;
}

// ---------------------------------
// Item Table Calculations
// ---------------------------------
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
        Math.abs(total - Math.round((frm.doc.extracted_amount || 0) * 100)) /
        100,
    });
  }, 200);
}