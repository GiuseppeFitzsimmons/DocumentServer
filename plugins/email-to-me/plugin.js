(function (window, undefined) {
  "use strict";

  var PLUGIN_GUID = "asc.{B5C5E3D0-7F2A-4E91-9C12-EUROBUREAU001}";

  window.Asc.plugin.init = function () {
    // Add a button to the Home tab
    window.Asc.plugin.executeMethod("AddToolbarMenuItem", [{
      guid: PLUGIN_GUID,
      tabs: [{
        id: "home",
        text: "Home",
        items: [{
          id: "email-to-me-btn",
          type: "button",
          text: "Email to me",
          hint: "Send this document to your email",
          data: "email_to_me",
          lockInViewMode: false,
          enableToggle: false,
          separator: true,
          icons: "resources/%theme-type%(light|dark)/icon%state%(normal)%scale%(default|*).%extension%(svg)",
          items: []
        }]
      }]
    }]);
  };

  window.Asc.plugin.event_onToolbarMenuClick = function (id) {
    if (id !== "email-to-me-btn") return;

    // Get the file ID from the parent page URL (format: /editor/:fileId)
    var fileId;
    try {
      var pathParts = window.parent.location.pathname.split("/");
      fileId = pathParts[pathParts.length - 1];
    } catch (e) {
      fileId = null;
    }

    if (!fileId) {
      window.Asc.plugin.executeMethod("ShowMessage", ["Could not determine file ID"]);
      return;
    }

    // Call the platform API from the parent frame context
    window.parent.fetch("/api/files/" + fileId + "/email-to-me", {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" }
    })
      .then(function (res) {
        if (!res.ok) {
          return res.json().then(function (data) {
            throw new Error(data.error || "Failed to send email");
          });
        }
        return res.json();
      })
      .then(function (data) {
        window.Asc.plugin.executeMethod("ShowMessage", [
          "Document sent to " + data.email
        ]);
      })
      .catch(function (err) {
        window.Asc.plugin.executeMethod("ShowMessage", [
          "Error: " + (err.message || "Could not send email")
        ]);
      });
  };

  window.Asc.plugin.button = function () {};
})(window);
