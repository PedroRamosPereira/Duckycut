/**
 * CSInterface.js — Adobe CEP Communication Library
 * Compatible with CSXS 9.x–11.x / Premiere Pro 14+
 */

var SystemPath = {
    USER_DATA: "userData",
    COMMON_FILES: "commonFiles",
    MY_DOCUMENTS: "myDocuments",
    APPLICATION: "application",
    EXTENSION: "extension",
    HOST_APPLICATION: "hostApplication",
};

/**
 * @constructor
 */
function CSInterface() {
    this.hostEnvironment = null;
}

/**
 * Evaluates an ExtendScript expression in the host application.
 * @param {string} script - The ExtendScript code to evaluate.
 * @param {function} [callback] - Callback receiving the result string.
 */
CSInterface.prototype.evalScript = function (script, callback) {
    if (typeof callback !== "function") {
        callback = function () {};
    }
    if (typeof window.__adobe_cep__ !== "undefined") {
        window.__adobe_cep__.evalScript(script, callback);
    } else {
        console.warn("[CSInterface] Not in CEP. Script:", script);
        callback("EvalScript_ErrMessage");
    }
};

/**
 * Returns the system path of the given type.
 * @param {string} pathType - One of the SystemPath constants.
 * @returns {string} The path string.
 */
CSInterface.prototype.getSystemPath = function (pathType) {
    if (typeof window.__adobe_cep__ !== "undefined") {
        return window.__adobe_cep__.getSystemPath(pathType);
    }
    return "";
};

/**
 * Returns the host environment data.
 * @returns {Object} Host environment info (appName, appVersion, appSkinInfo, etc.).
 */
CSInterface.prototype.getHostEnvironment = function () {
    if (typeof window.__adobe_cep__ !== "undefined") {
        try {
            return JSON.parse(window.__adobe_cep__.getHostEnvironment());
        } catch (e) {
            return {};
        }
    }
    return {};
};

/**
 * Registers a listener for a CEP event.
 * @param {string} type - The event type.
 * @param {function} listener - The event handler.
 * @param {Object} [obj] - Optional context object.
 */
CSInterface.prototype.addEventListener = function (type, listener, obj) {
    if (typeof window.__adobe_cep__ !== "undefined") {
        window.__adobe_cep__.addEventListener(type, listener, obj);
    }
};

/**
 * Removes a CEP event listener.
 * @param {string} type - The event type.
 * @param {function} listener - The event handler.
 * @param {Object} [obj] - Optional context object.
 */
CSInterface.prototype.removeEventListener = function (type, listener, obj) {
    if (typeof window.__adobe_cep__ !== "undefined") {
        window.__adobe_cep__.removeEventListener(type, listener, obj);
    }
};

/**
 * Dispatches a CEP event.
 * @param {Object} event - Event object with type and optional data.
 */
CSInterface.prototype.dispatchEvent = function (event) {
    if (typeof window.__adobe_cep__ !== "undefined") {
        window.__adobe_cep__.dispatchEvent(event);
    }
};

/**
 * Opens a URL in the default browser.
 * @param {string} url - The URL to open.
 */
CSInterface.prototype.openURLInDefaultBrowser = function (url) {
    if (typeof window.__adobe_cep__ !== "undefined") {
        window.__adobe_cep__.openURLInDefaultBrowser(url);
    }
};

/**
 * Requests opening another extension.
 * @param {string} extensionId - The extension ID.
 */
CSInterface.prototype.requestOpenExtension = function (extensionId) {
    if (typeof window.__adobe_cep__ !== "undefined") {
        window.__adobe_cep__.requestOpenExtension(extensionId);
    }
};

/**
 * Returns the extension ID.
 * @returns {string} Extension ID.
 */
CSInterface.prototype.getExtensionID = function () {
    if (typeof window.__adobe_cep__ !== "undefined") {
        return window.__adobe_cep__.getExtensionId();
    }
    return "";
};

/**
 * Returns the scale factor of the current screen.
 * @returns {number} Scale factor.
 */
CSInterface.prototype.getScaleFactor = function () {
    if (typeof window.__adobe_cep__ !== "undefined" && window.__adobe_cep__.getScaleFactor) {
        return window.__adobe_cep__.getScaleFactor();
    }
    return 1;
};

/**
 * Closes the current extension.
 */
CSInterface.prototype.closeExtension = function () {
    if (typeof window.__adobe_cep__ !== "undefined") {
        window.__adobe_cep__.closeExtension();
    }
};
