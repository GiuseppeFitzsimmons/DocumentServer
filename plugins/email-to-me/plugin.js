(function (window, undefined) {
  "use strict";

  var FLAG = "__eurobureau_email_plugin_ready";

  window.Asc.plugin.init = function () {
    if (!window.top[FLAG]) {
      // First init (autostart): register the toolbar button, set flag
      window.top[FLAG] = true;

      window.Asc.plugin.executeMethod("AddToolbarMenuItem", [{
        guid: window.Asc.plugin.guid,
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
            icons: "resources/%theme-type%(light|dark)/icon.svg",
            items: []
          }]
        }]
      }]);
      return;
    }

    // Subsequent init = button was clicked
    sendEmailToMe();
  };

  function sendEmailToMe() {
    var fileId;
    try {
      var pathParts = window.top.location.pathname.split("/");
      // URL is /editor/:fileId
      fileId = pathParts[pathParts.length - 1];
    } catch (e) {
      fileId = null;
    }

    if (!fileId || fileId.length < 30) {
      window.Asc.plugin.executeMethod("ShowMessage", ["Could not determine file ID"]);
      return;
    }

    window.top.fetch("/api/files/" + fileId + "/email-to-me", {
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
  }

  window.Asc.plugin.button = function () {};
})(window);
