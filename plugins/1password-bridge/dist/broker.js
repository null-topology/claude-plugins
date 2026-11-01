import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __require = /* @__PURE__ */ ((x) => typeof require !== "undefined" ? require : typeof Proxy !== "undefined" ? new Proxy(x, {
  get: (a, b) => (typeof require !== "undefined" ? require : a)[b]
}) : x)(function(x) {
  if (typeof require !== "undefined") return require.apply(this, arguments);
  throw Error('Dynamic require of "' + x + '" is not supported');
});
var __esm = (fn, res, err) => function __init() {
  if (err) throw err[0];
  try {
    return fn && (res = (0, fn[__getOwnPropNames(fn)[0]])(fn = 0)), res;
  } catch (e) {
    throw err = [e], e;
  }
};
var __commonJS = (cb, mod) => function __require2() {
  try {
    return mod || (0, cb[__getOwnPropNames(cb)[0]])((mod = { exports: {} }).exports, mod), mod.exports;
  } catch (e) {
    throw mod = 0, e;
  }
};
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/sdk-core-stub.ts
var sdk_core_stub_exports = {};
__export(sdk_core_stub_exports, {
  init_client: () => init_client,
  init_client_oidc: () => init_client_oidc,
  invoke: () => invoke,
  invoke_sync: () => invoke_sync,
  release_client: () => release_client
});
async function init_client(_config) {
  throw new Error(REFUSAL);
}
async function init_client_oidc(_config, _fetcher) {
  throw new Error(REFUSAL);
}
async function invoke(_parameters) {
  throw new Error(REFUSAL);
}
function invoke_sync(_parameters) {
  throw new Error(REFUSAL);
}
function release_client(_clientId) {
  throw new Error(REFUSAL);
}
var REFUSAL;
var init_sdk_core_stub = __esm({
  "src/sdk-core-stub.ts"() {
    "use strict";
    REFUSAL = "1password-bridge ships desktop authentication only";
  }
});

// node_modules/@1password/sdk/dist/types.js
var require_types = __commonJS({
  "node_modules/@1password/sdk/dist/types.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.ReplacerFunc = exports.ReviverFunc = exports.UPDATE_ITEM_HISTORY = exports.UPDATE_ITEMS = exports.SEND_ITEMS = exports.REVEAL_ITEM_PASSWORD = exports.RECOVER_VAULT = exports.READ_ITEMS = exports.PRINT_ITEMS = exports.NO_ACCESS = exports.MANAGE_VAULT = exports.IMPORT_ITEMS = exports.EXPORT_ITEMS = exports.DELETE_ITEMS = exports.CREATE_ITEMS = exports.ARCHIVE_ITEMS = exports.WordListType = exports.SeparatorType = exports.VaultType = exports.AllowedRecipientType = exports.AllowedType = exports.ItemShareDuration = exports.ItemState = exports.AutofillBehavior = exports.ItemFieldType = exports.ItemCategory = exports.VaultAccessorType = exports.GroupState = exports.GroupType = void 0;
    var GroupType;
    (function(GroupType2) {
      GroupType2["Owners"] = "owners";
      GroupType2["Administrators"] = "administrators";
      GroupType2["Recovery"] = "recovery";
      GroupType2["ExternalAccountManagers"] = "externalAccountManagers";
      GroupType2["TeamMembers"] = "teamMembers";
      GroupType2["UserDefined"] = "userDefined";
      GroupType2["Unsupported"] = "unsupported";
    })(GroupType || (exports.GroupType = GroupType = {}));
    var GroupState;
    (function(GroupState2) {
      GroupState2["Active"] = "active";
      GroupState2["Deleted"] = "deleted";
      GroupState2["Unsupported"] = "unsupported";
    })(GroupState || (exports.GroupState = GroupState = {}));
    var VaultAccessorType;
    (function(VaultAccessorType2) {
      VaultAccessorType2["User"] = "user";
      VaultAccessorType2["Group"] = "group";
      VaultAccessorType2["Broker"] = "broker";
    })(VaultAccessorType || (exports.VaultAccessorType = VaultAccessorType = {}));
    var ItemCategory;
    (function(ItemCategory2) {
      ItemCategory2["Login"] = "Login";
      ItemCategory2["SecureNote"] = "SecureNote";
      ItemCategory2["CreditCard"] = "CreditCard";
      ItemCategory2["CryptoWallet"] = "CryptoWallet";
      ItemCategory2["Identity"] = "Identity";
      ItemCategory2["Password"] = "Password";
      ItemCategory2["Document"] = "Document";
      ItemCategory2["ApiCredentials"] = "ApiCredentials";
      ItemCategory2["BankAccount"] = "BankAccount";
      ItemCategory2["Database"] = "Database";
      ItemCategory2["DriverLicense"] = "DriverLicense";
      ItemCategory2["Email"] = "Email";
      ItemCategory2["MedicalRecord"] = "MedicalRecord";
      ItemCategory2["Membership"] = "Membership";
      ItemCategory2["OutdoorLicense"] = "OutdoorLicense";
      ItemCategory2["Passport"] = "Passport";
      ItemCategory2["Rewards"] = "Rewards";
      ItemCategory2["Router"] = "Router";
      ItemCategory2["Server"] = "Server";
      ItemCategory2["SshKey"] = "SshKey";
      ItemCategory2["SocialSecurityNumber"] = "SocialSecurityNumber";
      ItemCategory2["SoftwareLicense"] = "SoftwareLicense";
      ItemCategory2["Person"] = "Person";
      ItemCategory2["Unsupported"] = "Unsupported";
    })(ItemCategory || (exports.ItemCategory = ItemCategory = {}));
    var ItemFieldType;
    (function(ItemFieldType2) {
      ItemFieldType2["Text"] = "Text";
      ItemFieldType2["Concealed"] = "Concealed";
      ItemFieldType2["CreditCardType"] = "CreditCardType";
      ItemFieldType2["CreditCardNumber"] = "CreditCardNumber";
      ItemFieldType2["Phone"] = "Phone";
      ItemFieldType2["Url"] = "Url";
      ItemFieldType2["Totp"] = "Totp";
      ItemFieldType2["Email"] = "Email";
      ItemFieldType2["Reference"] = "Reference";
      ItemFieldType2["SshKey"] = "SshKey";
      ItemFieldType2["Menu"] = "Menu";
      ItemFieldType2["MonthYear"] = "MonthYear";
      ItemFieldType2["Address"] = "Address";
      ItemFieldType2["Date"] = "Date";
      ItemFieldType2["Unsupported"] = "Unsupported";
    })(ItemFieldType || (exports.ItemFieldType = ItemFieldType = {}));
    var AutofillBehavior;
    (function(AutofillBehavior2) {
      AutofillBehavior2["AnywhereOnWebsite"] = "AnywhereOnWebsite";
      AutofillBehavior2["ExactDomain"] = "ExactDomain";
      AutofillBehavior2["Never"] = "Never";
    })(AutofillBehavior || (exports.AutofillBehavior = AutofillBehavior = {}));
    var ItemState;
    (function(ItemState2) {
      ItemState2["Active"] = "active";
      ItemState2["Archived"] = "archived";
    })(ItemState || (exports.ItemState = ItemState = {}));
    var ItemShareDuration;
    (function(ItemShareDuration2) {
      ItemShareDuration2["OneHour"] = "OneHour";
      ItemShareDuration2["OneDay"] = "OneDay";
      ItemShareDuration2["SevenDays"] = "SevenDays";
      ItemShareDuration2["FourteenDays"] = "FourteenDays";
      ItemShareDuration2["ThirtyDays"] = "ThirtyDays";
    })(ItemShareDuration || (exports.ItemShareDuration = ItemShareDuration = {}));
    var AllowedType;
    (function(AllowedType2) {
      AllowedType2["Authenticated"] = "Authenticated";
      AllowedType2["Public"] = "Public";
    })(AllowedType || (exports.AllowedType = AllowedType = {}));
    var AllowedRecipientType;
    (function(AllowedRecipientType2) {
      AllowedRecipientType2["Email"] = "Email";
      AllowedRecipientType2["Domain"] = "Domain";
    })(AllowedRecipientType || (exports.AllowedRecipientType = AllowedRecipientType = {}));
    var VaultType;
    (function(VaultType2) {
      VaultType2["Personal"] = "personal";
      VaultType2["Everyone"] = "everyone";
      VaultType2["Transfer"] = "transfer";
      VaultType2["UserCreated"] = "userCreated";
      VaultType2["Unsupported"] = "unsupported";
    })(VaultType || (exports.VaultType = VaultType = {}));
    var SeparatorType;
    (function(SeparatorType2) {
      SeparatorType2["Digits"] = "digits";
      SeparatorType2["DigitsAndSymbols"] = "digitsAndSymbols";
      SeparatorType2["Spaces"] = "spaces";
      SeparatorType2["Hyphens"] = "hyphens";
      SeparatorType2["Underscores"] = "underscores";
      SeparatorType2["Periods"] = "periods";
      SeparatorType2["Commas"] = "commas";
    })(SeparatorType || (exports.SeparatorType = SeparatorType = {}));
    var WordListType;
    (function(WordListType2) {
      WordListType2["FullWords"] = "fullWords";
      WordListType2["Syllables"] = "syllables";
      WordListType2["ThreeLetters"] = "threeLetters";
    })(WordListType || (exports.WordListType = WordListType = {}));
    exports.ARCHIVE_ITEMS = 256;
    exports.CREATE_ITEMS = 128;
    exports.DELETE_ITEMS = 512;
    exports.EXPORT_ITEMS = 4194304;
    exports.IMPORT_ITEMS = 2097152;
    exports.MANAGE_VAULT = 2;
    exports.NO_ACCESS = 0;
    exports.PRINT_ITEMS = 8388608;
    exports.READ_ITEMS = 32;
    exports.RECOVER_VAULT = 1;
    exports.REVEAL_ITEM_PASSWORD = 16;
    exports.SEND_ITEMS = 1048576;
    exports.UPDATE_ITEMS = 64;
    exports.UPDATE_ITEM_HISTORY = 1024;
    var ReviverFunc = (key, value) => {
      if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/.test(value) && (key === "createdAt" || key === "updatedAt")) {
        return new Date(value);
      }
      if (Array.isArray(value) && value.every((v) => Number.isInteger(v) && v >= 0 && v <= 255) && value.length > 0) {
        return new Uint8Array(value);
      }
      return value;
    };
    exports.ReviverFunc = ReviverFunc;
    var ReplacerFunc = (key, value) => {
      if (value instanceof Date) {
        return value.toISOString();
      }
      if (value instanceof Uint8Array) {
        return Array.from(value);
      }
      return value;
    };
    exports.ReplacerFunc = ReplacerFunc;
  }
});

// node_modules/@1password/sdk/dist/errors.js
var require_errors = __commonJS({
  "node_modules/@1password/sdk/dist/errors.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.throwError = exports.AuthExpiredError = exports.RateLimitExceededError = exports.DesktopSessionExpiredError = void 0;
    var DesktopSessionExpiredError = class extends Error {
      constructor(message) {
        super();
        this.message = message;
      }
    };
    exports.DesktopSessionExpiredError = DesktopSessionExpiredError;
    var RateLimitExceededError = class extends Error {
      constructor(message) {
        super();
        this.message = message;
      }
    };
    exports.RateLimitExceededError = RateLimitExceededError;
    var AuthExpiredError = class extends Error {
      constructor(message) {
        super();
        this.message = message;
      }
    };
    exports.AuthExpiredError = AuthExpiredError;
    var throwError = (errString) => {
      let err;
      try {
        err = JSON.parse(errString);
      } catch (e) {
        throw new Error(errString);
      }
      switch (err.name) {
        case "DesktopSessionExpired":
          throw new DesktopSessionExpiredError(err.message);
        case "RateLimitExceeded":
          throw new RateLimitExceededError(err.message);
        case "AuthExpired":
          throw new AuthExpiredError(err.message);
        default:
          throw new Error(err.message);
      }
    };
    exports.throwError = throwError;
  }
});

// node_modules/@1password/sdk/dist/core.js
var require_core = __commonJS({
  "node_modules/@1password/sdk/dist/core.js"(exports) {
    "use strict";
    var __awaiter = exports && exports.__awaiter || function(thisArg, _arguments, P, generator) {
      function adopt(value) {
        return value instanceof P ? value : new P(function(resolve2) {
          resolve2(value);
        });
      }
      return new (P || (P = Promise))(function(resolve2, reject) {
        function fulfilled(value) {
          try {
            step(generator.next(value));
          } catch (e) {
            reject(e);
          }
        }
        function rejected(value) {
          try {
            step(generator["throw"](value));
          } catch (e) {
            reject(e);
          }
        }
        function step(result) {
          result.done ? resolve2(result.value) : adopt(result.value).then(fulfilled, rejected);
        }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
      });
    };
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.InnerClient = exports.SharedCore = exports.WasmCore = void 0;
    var sdk_core_1 = (init_sdk_core_stub(), __toCommonJS(sdk_core_stub_exports));
    var types_1 = require_types();
    var errors_1 = require_errors();
    var messageLimit = 50 * 1024 * 1024;
    var WasmCore = class {
      initClient(config) {
        return __awaiter(this, void 0, void 0, function* () {
          try {
            return yield (0, sdk_core_1.init_client)(config);
          } catch (e) {
            (0, errors_1.throwError)(e);
          }
        });
      }
      initClientOidc(config, fetcher) {
        return __awaiter(this, void 0, void 0, function* () {
          try {
            return yield (0, sdk_core_1.init_client_oidc)(config, fetcher);
          } catch (e) {
            (0, errors_1.throwError)(e);
          }
        });
      }
      invoke(config) {
        return __awaiter(this, void 0, void 0, function* () {
          try {
            return yield (0, sdk_core_1.invoke)(config);
          } catch (e) {
            (0, errors_1.throwError)(e);
          }
        });
      }
      releaseClient(clientId) {
        try {
          (0, sdk_core_1.release_client)(clientId);
        } catch (e) {
          console.warn("failed to release client:", e);
        }
      }
    };
    exports.WasmCore = WasmCore;
    var SharedCore = class {
      constructor() {
        this.inner = new WasmCore();
      }
      setInner(core) {
        this.inner = core;
      }
      initClient(config) {
        return __awaiter(this, void 0, void 0, function* () {
          const serializedConfig = JSON.stringify(config);
          return this.inner.initClient(serializedConfig);
        });
      }
      initClientOidc(config, fetcher) {
        return __awaiter(this, void 0, void 0, function* () {
          const serializedConfig = JSON.stringify(config);
          return this.inner.initClientOidc(serializedConfig, fetcher);
        });
      }
      invoke(config) {
        return __awaiter(this, void 0, void 0, function* () {
          const serializedConfig = JSON.stringify(config, types_1.ReplacerFunc);
          if (new TextEncoder().encode(serializedConfig).length > messageLimit) {
            (0, errors_1.throwError)(`message size exceeds the limit of ${messageLimit} bytes, please contact 1Password at support@1password.com or https://developer.1password.com/joinslack if you need help."`);
          }
          return this.inner.invoke(serializedConfig);
        });
      }
      invoke_sync(config) {
        const serializedConfig = JSON.stringify(config, types_1.ReplacerFunc);
        if (new TextEncoder().encode(serializedConfig).length > messageLimit) {
          (0, errors_1.throwError)(`message size exceeds the limit of ${messageLimit} bytes, please contact 1Password at support@1password.com or https://developer.1password.com/joinslack if you need help.`);
        }
        return (0, sdk_core_1.invoke_sync)(serializedConfig);
      }
      releaseClient(clientId) {
        const serializedId = JSON.stringify(clientId);
        this.inner.releaseClient(serializedId);
      }
    };
    exports.SharedCore = SharedCore;
    var InnerClient = class {
      constructor(id, core, config) {
        this.id = id;
        this.core = core;
        this.config = config;
      }
      invoke(config) {
        return __awaiter(this, void 0, void 0, function* () {
          try {
            return yield this.core.invoke(config);
          } catch (err) {
            if (err instanceof errors_1.DesktopSessionExpiredError) {
              const newId = yield this.core.initClient(this.config);
              this.id = parseInt(newId, 10);
              config.invocation.clientId = this.id;
              return yield this.core.invoke(config);
            }
            throw err;
          }
        });
      }
    };
    exports.InnerClient = InnerClient;
  }
});

// node_modules/@1password/sdk/dist/version.js
var require_version = __commonJS({
  "node_modules/@1password/sdk/dist/version.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.SDK_BUILD_NUMBER = exports.SDK_VERSION = void 0;
    exports.SDK_VERSION = "0.5.0";
    exports.SDK_BUILD_NUMBER = "0050002";
  }
});

// node_modules/@1password/sdk/dist/configuration.js
var require_configuration = __commonJS({
  "node_modules/@1password/sdk/dist/configuration.js"(exports) {
    "use strict";
    var __importDefault = exports && exports.__importDefault || function(mod) {
      return mod && mod.__esModule ? mod : { "default": mod };
    };
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.getOsName = exports.clientAuthConfig = exports.DesktopAuth = exports.VERSION = exports.LANGUAGE = void 0;
    var os_1 = __importDefault(__require("os"));
    var version_js_1 = require_version();
    exports.LANGUAGE = "JS";
    exports.VERSION = version_js_1.SDK_BUILD_NUMBER;
    var DesktopAuth = class {
      constructor(accountName) {
        this.accountName = accountName;
      }
    };
    exports.DesktopAuth = DesktopAuth;
    var clientAuthConfig = (userConfig) => {
      const defaultOsVersion = "0.0.0";
      let serviceAccountToken;
      let accountName;
      if (typeof userConfig.auth === "string") {
        serviceAccountToken = userConfig.auth;
      } else if (userConfig.auth instanceof DesktopAuth) {
        accountName = userConfig.auth.accountName;
      }
      return {
        serviceAccountToken: serviceAccountToken !== null && serviceAccountToken !== void 0 ? serviceAccountToken : "",
        accountName,
        programmingLanguage: exports.LANGUAGE,
        sdkVersion: exports.VERSION,
        integrationName: userConfig.integrationName,
        integrationVersion: userConfig.integrationVersion,
        requestLibraryName: "Fetch API",
        requestLibraryVersion: "Fetch API",
        os: (0, exports.getOsName)(),
        osVersion: defaultOsVersion,
        architecture: os_1.default.arch(),
        workloadDetails: userConfig.workloadDetails
      };
    };
    exports.clientAuthConfig = clientAuthConfig;
    var getOsName = () => {
      const os_name = os_1.default.type().toLowerCase();
      if (os_name === "windows_nt") {
        return "windows";
      }
      return os_name;
    };
    exports.getOsName = getOsName;
  }
});

// node_modules/@1password/sdk/dist/secrets.js
var require_secrets = __commonJS({
  "node_modules/@1password/sdk/dist/secrets.js"(exports) {
    "use strict";
    var __awaiter = exports && exports.__awaiter || function(thisArg, _arguments, P, generator) {
      function adopt(value) {
        return value instanceof P ? value : new P(function(resolve2) {
          resolve2(value);
        });
      }
      return new (P || (P = Promise))(function(resolve2, reject) {
        function fulfilled(value) {
          try {
            step(generator.next(value));
          } catch (e) {
            reject(e);
          }
        }
        function rejected(value) {
          try {
            step(generator["throw"](value));
          } catch (e) {
            reject(e);
          }
        }
        function step(result) {
          result.done ? resolve2(result.value) : adopt(result.value).then(fulfilled, rejected);
        }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
      });
    };
    var __classPrivateFieldSet = exports && exports.__classPrivateFieldSet || function(receiver, state, value, kind, f) {
      if (kind === "m") throw new TypeError("Private method is not writable");
      if (kind === "a" && !f) throw new TypeError("Private accessor was defined without a setter");
      if (typeof state === "function" ? receiver !== state || !f : !state.has(receiver)) throw new TypeError("Cannot write private member to an object whose class did not declare it");
      return kind === "a" ? f.call(receiver, value) : f ? f.value = value : state.set(receiver, value), value;
    };
    var __classPrivateFieldGet = exports && exports.__classPrivateFieldGet || function(receiver, state, kind, f) {
      if (kind === "a" && !f) throw new TypeError("Private accessor was defined without a getter");
      if (typeof state === "function" ? receiver !== state || !f : !state.has(receiver)) throw new TypeError("Cannot read private member from an object whose class did not declare it");
      return kind === "m" ? f : kind === "a" ? f.call(receiver) : f ? f.value : state.get(receiver);
    };
    var _Secrets_inner;
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.Secrets = void 0;
    var core_js_1 = require_core();
    var types_js_1 = require_types();
    var Secrets = class {
      constructor(inner) {
        _Secrets_inner.set(this, void 0);
        __classPrivateFieldSet(this, _Secrets_inner, inner, "f");
      }
      /**
       * Resolve returns the secret the provided secret reference points to.
       */
      resolve(secretReference) {
        return __awaiter(this, void 0, void 0, function* () {
          const invocationConfig = {
            invocation: {
              clientId: __classPrivateFieldGet(this, _Secrets_inner, "f").id,
              parameters: {
                name: "SecretsResolve",
                parameters: {
                  secret_reference: secretReference
                }
              }
            }
          };
          return JSON.parse(yield __classPrivateFieldGet(this, _Secrets_inner, "f").invoke(invocationConfig), types_js_1.ReviverFunc);
        });
      }
      /**
       * Resolve takes in a list of secret references and returns the secrets they point to or errors if any.
       */
      resolveAll(secretReferences) {
        return __awaiter(this, void 0, void 0, function* () {
          const invocationConfig = {
            invocation: {
              clientId: __classPrivateFieldGet(this, _Secrets_inner, "f").id,
              parameters: {
                name: "SecretsResolveAll",
                parameters: {
                  secret_references: secretReferences
                }
              }
            }
          };
          return JSON.parse(yield __classPrivateFieldGet(this, _Secrets_inner, "f").invoke(invocationConfig), types_js_1.ReviverFunc);
        });
      }
      /**
       * Validate the secret reference to ensure there are no syntax errors.
       */
      static validateSecretReference(secretReference) {
        const sharedCore = new core_js_1.SharedCore();
        const invocationConfig = {
          invocation: {
            parameters: {
              name: "ValidateSecretReference",
              parameters: {
                secret_reference: secretReference
              }
            }
          }
        };
        sharedCore.invoke_sync(invocationConfig);
      }
      /**
       * Generate a password using the provided recipe.
       */
      static generatePassword(recipe) {
        const sharedCore = new core_js_1.SharedCore();
        const invocationConfig = {
          invocation: {
            parameters: {
              name: "GeneratePassword",
              parameters: {
                recipe
              }
            }
          }
        };
        return JSON.parse(sharedCore.invoke_sync(invocationConfig), types_js_1.ReviverFunc);
      }
    };
    exports.Secrets = Secrets;
    _Secrets_inner = /* @__PURE__ */ new WeakMap();
  }
});

// node_modules/@1password/sdk/dist/items_shares.js
var require_items_shares = __commonJS({
  "node_modules/@1password/sdk/dist/items_shares.js"(exports) {
    "use strict";
    var __awaiter = exports && exports.__awaiter || function(thisArg, _arguments, P, generator) {
      function adopt(value) {
        return value instanceof P ? value : new P(function(resolve2) {
          resolve2(value);
        });
      }
      return new (P || (P = Promise))(function(resolve2, reject) {
        function fulfilled(value) {
          try {
            step(generator.next(value));
          } catch (e) {
            reject(e);
          }
        }
        function rejected(value) {
          try {
            step(generator["throw"](value));
          } catch (e) {
            reject(e);
          }
        }
        function step(result) {
          result.done ? resolve2(result.value) : adopt(result.value).then(fulfilled, rejected);
        }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
      });
    };
    var __classPrivateFieldSet = exports && exports.__classPrivateFieldSet || function(receiver, state, value, kind, f) {
      if (kind === "m") throw new TypeError("Private method is not writable");
      if (kind === "a" && !f) throw new TypeError("Private accessor was defined without a setter");
      if (typeof state === "function" ? receiver !== state || !f : !state.has(receiver)) throw new TypeError("Cannot write private member to an object whose class did not declare it");
      return kind === "a" ? f.call(receiver, value) : f ? f.value = value : state.set(receiver, value), value;
    };
    var __classPrivateFieldGet = exports && exports.__classPrivateFieldGet || function(receiver, state, kind, f) {
      if (kind === "a" && !f) throw new TypeError("Private accessor was defined without a getter");
      if (typeof state === "function" ? receiver !== state || !f : !state.has(receiver)) throw new TypeError("Cannot read private member from an object whose class did not declare it");
      return kind === "m" ? f : kind === "a" ? f.call(receiver) : f ? f.value : state.get(receiver);
    };
    var _ItemsShares_inner;
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.ItemsShares = void 0;
    var types_js_1 = require_types();
    var ItemsShares = class {
      constructor(inner) {
        _ItemsShares_inner.set(this, void 0);
        __classPrivateFieldSet(this, _ItemsShares_inner, inner, "f");
      }
      /**
       * Get the item sharing policy of your account.
       */
      getAccountPolicy(vaultId, itemId) {
        return __awaiter(this, void 0, void 0, function* () {
          const invocationConfig = {
            invocation: {
              clientId: __classPrivateFieldGet(this, _ItemsShares_inner, "f").id,
              parameters: {
                name: "ItemsSharesGetAccountPolicy",
                parameters: {
                  vault_id: vaultId,
                  item_id: itemId
                }
              }
            }
          };
          return JSON.parse(yield __classPrivateFieldGet(this, _ItemsShares_inner, "f").invoke(invocationConfig), types_js_1.ReviverFunc);
        });
      }
      /**
       * Validate the recipients of an item sharing link.
       */
      validateRecipients(policy, recipients) {
        return __awaiter(this, void 0, void 0, function* () {
          const invocationConfig = {
            invocation: {
              clientId: __classPrivateFieldGet(this, _ItemsShares_inner, "f").id,
              parameters: {
                name: "ItemsSharesValidateRecipients",
                parameters: {
                  policy,
                  recipients
                }
              }
            }
          };
          return JSON.parse(yield __classPrivateFieldGet(this, _ItemsShares_inner, "f").invoke(invocationConfig), types_js_1.ReviverFunc);
        });
      }
      /**
       * Create a new item sharing link.
       */
      create(item, policy, params) {
        return __awaiter(this, void 0, void 0, function* () {
          const invocationConfig = {
            invocation: {
              clientId: __classPrivateFieldGet(this, _ItemsShares_inner, "f").id,
              parameters: {
                name: "ItemsSharesCreate",
                parameters: {
                  item,
                  policy,
                  params
                }
              }
            }
          };
          return JSON.parse(yield __classPrivateFieldGet(this, _ItemsShares_inner, "f").invoke(invocationConfig), types_js_1.ReviverFunc);
        });
      }
    };
    exports.ItemsShares = ItemsShares;
    _ItemsShares_inner = /* @__PURE__ */ new WeakMap();
  }
});

// node_modules/@1password/sdk/dist/items_files.js
var require_items_files = __commonJS({
  "node_modules/@1password/sdk/dist/items_files.js"(exports) {
    "use strict";
    var __awaiter = exports && exports.__awaiter || function(thisArg, _arguments, P, generator) {
      function adopt(value) {
        return value instanceof P ? value : new P(function(resolve2) {
          resolve2(value);
        });
      }
      return new (P || (P = Promise))(function(resolve2, reject) {
        function fulfilled(value) {
          try {
            step(generator.next(value));
          } catch (e) {
            reject(e);
          }
        }
        function rejected(value) {
          try {
            step(generator["throw"](value));
          } catch (e) {
            reject(e);
          }
        }
        function step(result) {
          result.done ? resolve2(result.value) : adopt(result.value).then(fulfilled, rejected);
        }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
      });
    };
    var __classPrivateFieldSet = exports && exports.__classPrivateFieldSet || function(receiver, state, value, kind, f) {
      if (kind === "m") throw new TypeError("Private method is not writable");
      if (kind === "a" && !f) throw new TypeError("Private accessor was defined without a setter");
      if (typeof state === "function" ? receiver !== state || !f : !state.has(receiver)) throw new TypeError("Cannot write private member to an object whose class did not declare it");
      return kind === "a" ? f.call(receiver, value) : f ? f.value = value : state.set(receiver, value), value;
    };
    var __classPrivateFieldGet = exports && exports.__classPrivateFieldGet || function(receiver, state, kind, f) {
      if (kind === "a" && !f) throw new TypeError("Private accessor was defined without a getter");
      if (typeof state === "function" ? receiver !== state || !f : !state.has(receiver)) throw new TypeError("Cannot read private member from an object whose class did not declare it");
      return kind === "m" ? f : kind === "a" ? f.call(receiver) : f ? f.value : state.get(receiver);
    };
    var _ItemsFiles_inner;
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.ItemsFiles = void 0;
    var types_js_1 = require_types();
    var ItemsFiles = class {
      constructor(inner) {
        _ItemsFiles_inner.set(this, void 0);
        __classPrivateFieldSet(this, _ItemsFiles_inner, inner, "f");
      }
      /**
       * Attach files to Items.
       */
      attach(item, fileParams) {
        return __awaiter(this, void 0, void 0, function* () {
          const invocationConfig = {
            invocation: {
              clientId: __classPrivateFieldGet(this, _ItemsFiles_inner, "f").id,
              parameters: {
                name: "ItemsFilesAttach",
                parameters: {
                  item,
                  file_params: fileParams
                }
              }
            }
          };
          return JSON.parse(yield __classPrivateFieldGet(this, _ItemsFiles_inner, "f").invoke(invocationConfig), types_js_1.ReviverFunc);
        });
      }
      /**
       * Read file content from the Item.
       */
      read(vaultId, itemId, attr) {
        return __awaiter(this, void 0, void 0, function* () {
          const invocationConfig = {
            invocation: {
              clientId: __classPrivateFieldGet(this, _ItemsFiles_inner, "f").id,
              parameters: {
                name: "ItemsFilesRead",
                parameters: {
                  vault_id: vaultId,
                  item_id: itemId,
                  attr
                }
              }
            }
          };
          return JSON.parse(yield __classPrivateFieldGet(this, _ItemsFiles_inner, "f").invoke(invocationConfig), types_js_1.ReviverFunc);
        });
      }
      /**
       * Delete a field file from Item using the section and field IDs.
       */
      delete(item, sectionId, fieldId) {
        return __awaiter(this, void 0, void 0, function* () {
          const invocationConfig = {
            invocation: {
              clientId: __classPrivateFieldGet(this, _ItemsFiles_inner, "f").id,
              parameters: {
                name: "ItemsFilesDelete",
                parameters: {
                  item,
                  section_id: sectionId,
                  field_id: fieldId
                }
              }
            }
          };
          return JSON.parse(yield __classPrivateFieldGet(this, _ItemsFiles_inner, "f").invoke(invocationConfig), types_js_1.ReviverFunc);
        });
      }
      /**
       * Replace the document file within a document item.
       */
      replaceDocument(item, docParams) {
        return __awaiter(this, void 0, void 0, function* () {
          const invocationConfig = {
            invocation: {
              clientId: __classPrivateFieldGet(this, _ItemsFiles_inner, "f").id,
              parameters: {
                name: "ItemsFilesReplaceDocument",
                parameters: {
                  item,
                  doc_params: docParams
                }
              }
            }
          };
          return JSON.parse(yield __classPrivateFieldGet(this, _ItemsFiles_inner, "f").invoke(invocationConfig), types_js_1.ReviverFunc);
        });
      }
    };
    exports.ItemsFiles = ItemsFiles;
    _ItemsFiles_inner = /* @__PURE__ */ new WeakMap();
  }
});

// node_modules/@1password/sdk/dist/items.js
var require_items = __commonJS({
  "node_modules/@1password/sdk/dist/items.js"(exports) {
    "use strict";
    var __awaiter = exports && exports.__awaiter || function(thisArg, _arguments, P, generator) {
      function adopt(value) {
        return value instanceof P ? value : new P(function(resolve2) {
          resolve2(value);
        });
      }
      return new (P || (P = Promise))(function(resolve2, reject) {
        function fulfilled(value) {
          try {
            step(generator.next(value));
          } catch (e) {
            reject(e);
          }
        }
        function rejected(value) {
          try {
            step(generator["throw"](value));
          } catch (e) {
            reject(e);
          }
        }
        function step(result) {
          result.done ? resolve2(result.value) : adopt(result.value).then(fulfilled, rejected);
        }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
      });
    };
    var __classPrivateFieldSet = exports && exports.__classPrivateFieldSet || function(receiver, state, value, kind, f) {
      if (kind === "m") throw new TypeError("Private method is not writable");
      if (kind === "a" && !f) throw new TypeError("Private accessor was defined without a setter");
      if (typeof state === "function" ? receiver !== state || !f : !state.has(receiver)) throw new TypeError("Cannot write private member to an object whose class did not declare it");
      return kind === "a" ? f.call(receiver, value) : f ? f.value = value : state.set(receiver, value), value;
    };
    var __classPrivateFieldGet = exports && exports.__classPrivateFieldGet || function(receiver, state, kind, f) {
      if (kind === "a" && !f) throw new TypeError("Private accessor was defined without a getter");
      if (typeof state === "function" ? receiver !== state || !f : !state.has(receiver)) throw new TypeError("Cannot read private member from an object whose class did not declare it");
      return kind === "m" ? f : kind === "a" ? f.call(receiver) : f ? f.value : state.get(receiver);
    };
    var _Items_inner;
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.Items = void 0;
    var types_js_1 = require_types();
    var items_shares_js_1 = require_items_shares();
    var items_files_js_1 = require_items_files();
    var Items = class {
      constructor(inner) {
        _Items_inner.set(this, void 0);
        __classPrivateFieldSet(this, _Items_inner, inner, "f");
        this.shares = new items_shares_js_1.ItemsShares(inner);
        this.files = new items_files_js_1.ItemsFiles(inner);
      }
      /**
       * Create a new item.
       */
      create(params) {
        return __awaiter(this, void 0, void 0, function* () {
          const invocationConfig = {
            invocation: {
              clientId: __classPrivateFieldGet(this, _Items_inner, "f").id,
              parameters: {
                name: "ItemsCreate",
                parameters: {
                  params
                }
              }
            }
          };
          return JSON.parse(yield __classPrivateFieldGet(this, _Items_inner, "f").invoke(invocationConfig), types_js_1.ReviverFunc);
        });
      }
      /**
       * Create items in batch, within a single vault.
       */
      createAll(vaultId, params) {
        return __awaiter(this, void 0, void 0, function* () {
          const invocationConfig = {
            invocation: {
              clientId: __classPrivateFieldGet(this, _Items_inner, "f").id,
              parameters: {
                name: "ItemsCreateAll",
                parameters: {
                  vault_id: vaultId,
                  params
                }
              }
            }
          };
          return JSON.parse(yield __classPrivateFieldGet(this, _Items_inner, "f").invoke(invocationConfig), types_js_1.ReviverFunc);
        });
      }
      /**
       * Get an item by vault and item ID.
       */
      get(vaultId, itemId) {
        return __awaiter(this, void 0, void 0, function* () {
          const invocationConfig = {
            invocation: {
              clientId: __classPrivateFieldGet(this, _Items_inner, "f").id,
              parameters: {
                name: "ItemsGet",
                parameters: {
                  vault_id: vaultId,
                  item_id: itemId
                }
              }
            }
          };
          return JSON.parse(yield __classPrivateFieldGet(this, _Items_inner, "f").invoke(invocationConfig), types_js_1.ReviverFunc);
        });
      }
      /**
       * Get items by vault and their item IDs.
       */
      getAll(vaultId, itemIds) {
        return __awaiter(this, void 0, void 0, function* () {
          const invocationConfig = {
            invocation: {
              clientId: __classPrivateFieldGet(this, _Items_inner, "f").id,
              parameters: {
                name: "ItemsGetAll",
                parameters: {
                  vault_id: vaultId,
                  item_ids: itemIds
                }
              }
            }
          };
          return JSON.parse(yield __classPrivateFieldGet(this, _Items_inner, "f").invoke(invocationConfig), types_js_1.ReviverFunc);
        });
      }
      /**
       * Update an existing item.
       */
      put(item) {
        return __awaiter(this, void 0, void 0, function* () {
          const invocationConfig = {
            invocation: {
              clientId: __classPrivateFieldGet(this, _Items_inner, "f").id,
              parameters: {
                name: "ItemsPut",
                parameters: {
                  item
                }
              }
            }
          };
          return JSON.parse(yield __classPrivateFieldGet(this, _Items_inner, "f").invoke(invocationConfig), types_js_1.ReviverFunc);
        });
      }
      /**
       * Delete an item.
       */
      delete(vaultId, itemId) {
        return __awaiter(this, void 0, void 0, function* () {
          const invocationConfig = {
            invocation: {
              clientId: __classPrivateFieldGet(this, _Items_inner, "f").id,
              parameters: {
                name: "ItemsDelete",
                parameters: {
                  vault_id: vaultId,
                  item_id: itemId
                }
              }
            }
          };
          yield __classPrivateFieldGet(this, _Items_inner, "f").invoke(invocationConfig);
        });
      }
      /**
       * Delete items in batch, within a single vault.
       */
      deleteAll(vaultId, itemIds) {
        return __awaiter(this, void 0, void 0, function* () {
          const invocationConfig = {
            invocation: {
              clientId: __classPrivateFieldGet(this, _Items_inner, "f").id,
              parameters: {
                name: "ItemsDeleteAll",
                parameters: {
                  vault_id: vaultId,
                  item_ids: itemIds
                }
              }
            }
          };
          return JSON.parse(yield __classPrivateFieldGet(this, _Items_inner, "f").invoke(invocationConfig), types_js_1.ReviverFunc);
        });
      }
      /**
       * Archive an item.
       */
      archive(vaultId, itemId) {
        return __awaiter(this, void 0, void 0, function* () {
          const invocationConfig = {
            invocation: {
              clientId: __classPrivateFieldGet(this, _Items_inner, "f").id,
              parameters: {
                name: "ItemsArchive",
                parameters: {
                  vault_id: vaultId,
                  item_id: itemId
                }
              }
            }
          };
          yield __classPrivateFieldGet(this, _Items_inner, "f").invoke(invocationConfig);
        });
      }
      /**
       * List items based on filters.
       */
      list(vaultId, ...filters) {
        return __awaiter(this, void 0, void 0, function* () {
          const invocationConfig = {
            invocation: {
              clientId: __classPrivateFieldGet(this, _Items_inner, "f").id,
              parameters: {
                name: "ItemsList",
                parameters: {
                  vault_id: vaultId,
                  filters
                }
              }
            }
          };
          return JSON.parse(yield __classPrivateFieldGet(this, _Items_inner, "f").invoke(invocationConfig), types_js_1.ReviverFunc);
        });
      }
    };
    exports.Items = Items;
    _Items_inner = /* @__PURE__ */ new WeakMap();
  }
});

// node_modules/@1password/sdk/dist/vaults.js
var require_vaults = __commonJS({
  "node_modules/@1password/sdk/dist/vaults.js"(exports) {
    "use strict";
    var __awaiter = exports && exports.__awaiter || function(thisArg, _arguments, P, generator) {
      function adopt(value) {
        return value instanceof P ? value : new P(function(resolve2) {
          resolve2(value);
        });
      }
      return new (P || (P = Promise))(function(resolve2, reject) {
        function fulfilled(value) {
          try {
            step(generator.next(value));
          } catch (e) {
            reject(e);
          }
        }
        function rejected(value) {
          try {
            step(generator["throw"](value));
          } catch (e) {
            reject(e);
          }
        }
        function step(result) {
          result.done ? resolve2(result.value) : adopt(result.value).then(fulfilled, rejected);
        }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
      });
    };
    var __classPrivateFieldSet = exports && exports.__classPrivateFieldSet || function(receiver, state, value, kind, f) {
      if (kind === "m") throw new TypeError("Private method is not writable");
      if (kind === "a" && !f) throw new TypeError("Private accessor was defined without a setter");
      if (typeof state === "function" ? receiver !== state || !f : !state.has(receiver)) throw new TypeError("Cannot write private member to an object whose class did not declare it");
      return kind === "a" ? f.call(receiver, value) : f ? f.value = value : state.set(receiver, value), value;
    };
    var __classPrivateFieldGet = exports && exports.__classPrivateFieldGet || function(receiver, state, kind, f) {
      if (kind === "a" && !f) throw new TypeError("Private accessor was defined without a getter");
      if (typeof state === "function" ? receiver !== state || !f : !state.has(receiver)) throw new TypeError("Cannot read private member from an object whose class did not declare it");
      return kind === "m" ? f : kind === "a" ? f.call(receiver) : f ? f.value : state.get(receiver);
    };
    var _Vaults_inner;
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.Vaults = void 0;
    var types_js_1 = require_types();
    var Vaults = class {
      constructor(inner) {
        _Vaults_inner.set(this, void 0);
        __classPrivateFieldSet(this, _Vaults_inner, inner, "f");
      }
      /**
       * Create a new user vault.
       */
      create(params) {
        return __awaiter(this, void 0, void 0, function* () {
          const invocationConfig = {
            invocation: {
              clientId: __classPrivateFieldGet(this, _Vaults_inner, "f").id,
              parameters: {
                name: "VaultsCreate",
                parameters: {
                  params
                }
              }
            }
          };
          return JSON.parse(yield __classPrivateFieldGet(this, _Vaults_inner, "f").invoke(invocationConfig), types_js_1.ReviverFunc);
        });
      }
      /**
       * List information about vaults that's configurable based on some input parameters.
       */
      list(params) {
        return __awaiter(this, void 0, void 0, function* () {
          const invocationConfig = {
            invocation: {
              clientId: __classPrivateFieldGet(this, _Vaults_inner, "f").id,
              parameters: {
                name: "VaultsList",
                parameters: {
                  params
                }
              }
            }
          };
          return JSON.parse(yield __classPrivateFieldGet(this, _Vaults_inner, "f").invoke(invocationConfig), types_js_1.ReviverFunc);
        });
      }
      /**
       * Get an overview of a vault by its ID.
       */
      getOverview(vaultId) {
        return __awaiter(this, void 0, void 0, function* () {
          const invocationConfig = {
            invocation: {
              clientId: __classPrivateFieldGet(this, _Vaults_inner, "f").id,
              parameters: {
                name: "VaultsGetOverview",
                parameters: {
                  vault_id: vaultId
                }
              }
            }
          };
          return JSON.parse(yield __classPrivateFieldGet(this, _Vaults_inner, "f").invoke(invocationConfig), types_js_1.ReviverFunc);
        });
      }
      /**
       * Get detailed vault information by vault ID and parameters.
       */
      get(vaultId, vaultParams) {
        return __awaiter(this, void 0, void 0, function* () {
          const invocationConfig = {
            invocation: {
              clientId: __classPrivateFieldGet(this, _Vaults_inner, "f").id,
              parameters: {
                name: "VaultsGet",
                parameters: {
                  vault_id: vaultId,
                  vault_params: vaultParams
                }
              }
            }
          };
          return JSON.parse(yield __classPrivateFieldGet(this, _Vaults_inner, "f").invoke(invocationConfig), types_js_1.ReviverFunc);
        });
      }
      /**
       * Update a vault
       */
      update(vaultId, params) {
        return __awaiter(this, void 0, void 0, function* () {
          const invocationConfig = {
            invocation: {
              clientId: __classPrivateFieldGet(this, _Vaults_inner, "f").id,
              parameters: {
                name: "VaultsUpdate",
                parameters: {
                  vault_id: vaultId,
                  params
                }
              }
            }
          };
          return JSON.parse(yield __classPrivateFieldGet(this, _Vaults_inner, "f").invoke(invocationConfig), types_js_1.ReviverFunc);
        });
      }
      /**
       * Delete a vault by its ID.
       */
      delete(vaultId) {
        return __awaiter(this, void 0, void 0, function* () {
          const invocationConfig = {
            invocation: {
              clientId: __classPrivateFieldGet(this, _Vaults_inner, "f").id,
              parameters: {
                name: "VaultsDelete",
                parameters: {
                  vault_id: vaultId
                }
              }
            }
          };
          yield __classPrivateFieldGet(this, _Vaults_inner, "f").invoke(invocationConfig);
        });
      }
      /**
       * Grant group permissions to a vault.
       */
      grantGroupPermissions(vaultId, groupPermissionsList) {
        return __awaiter(this, void 0, void 0, function* () {
          const invocationConfig = {
            invocation: {
              clientId: __classPrivateFieldGet(this, _Vaults_inner, "f").id,
              parameters: {
                name: "VaultsGrantGroupPermissions",
                parameters: {
                  vault_id: vaultId,
                  group_permissions_list: groupPermissionsList
                }
              }
            }
          };
          yield __classPrivateFieldGet(this, _Vaults_inner, "f").invoke(invocationConfig);
        });
      }
      /**
       * Update group permissions for vaults.
       */
      updateGroupPermissions(groupPermissionsList) {
        return __awaiter(this, void 0, void 0, function* () {
          const invocationConfig = {
            invocation: {
              clientId: __classPrivateFieldGet(this, _Vaults_inner, "f").id,
              parameters: {
                name: "VaultsUpdateGroupPermissions",
                parameters: {
                  group_permissions_list: groupPermissionsList
                }
              }
            }
          };
          yield __classPrivateFieldGet(this, _Vaults_inner, "f").invoke(invocationConfig);
        });
      }
      /**
       * Revoke group permissions from a vault.
       */
      revokeGroupPermissions(vaultId, groupId) {
        return __awaiter(this, void 0, void 0, function* () {
          const invocationConfig = {
            invocation: {
              clientId: __classPrivateFieldGet(this, _Vaults_inner, "f").id,
              parameters: {
                name: "VaultsRevokeGroupPermissions",
                parameters: {
                  vault_id: vaultId,
                  group_id: groupId
                }
              }
            }
          };
          yield __classPrivateFieldGet(this, _Vaults_inner, "f").invoke(invocationConfig);
        });
      }
    };
    exports.Vaults = Vaults;
    _Vaults_inner = /* @__PURE__ */ new WeakMap();
  }
});

// node_modules/@1password/sdk/dist/environments.js
var require_environments = __commonJS({
  "node_modules/@1password/sdk/dist/environments.js"(exports) {
    "use strict";
    var __awaiter = exports && exports.__awaiter || function(thisArg, _arguments, P, generator) {
      function adopt(value) {
        return value instanceof P ? value : new P(function(resolve2) {
          resolve2(value);
        });
      }
      return new (P || (P = Promise))(function(resolve2, reject) {
        function fulfilled(value) {
          try {
            step(generator.next(value));
          } catch (e) {
            reject(e);
          }
        }
        function rejected(value) {
          try {
            step(generator["throw"](value));
          } catch (e) {
            reject(e);
          }
        }
        function step(result) {
          result.done ? resolve2(result.value) : adopt(result.value).then(fulfilled, rejected);
        }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
      });
    };
    var __classPrivateFieldSet = exports && exports.__classPrivateFieldSet || function(receiver, state, value, kind, f) {
      if (kind === "m") throw new TypeError("Private method is not writable");
      if (kind === "a" && !f) throw new TypeError("Private accessor was defined without a setter");
      if (typeof state === "function" ? receiver !== state || !f : !state.has(receiver)) throw new TypeError("Cannot write private member to an object whose class did not declare it");
      return kind === "a" ? f.call(receiver, value) : f ? f.value = value : state.set(receiver, value), value;
    };
    var __classPrivateFieldGet = exports && exports.__classPrivateFieldGet || function(receiver, state, kind, f) {
      if (kind === "a" && !f) throw new TypeError("Private accessor was defined without a getter");
      if (typeof state === "function" ? receiver !== state || !f : !state.has(receiver)) throw new TypeError("Cannot read private member from an object whose class did not declare it");
      return kind === "m" ? f : kind === "a" ? f.call(receiver) : f ? f.value : state.get(receiver);
    };
    var _Environments_inner;
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.Environments = void 0;
    var types_js_1 = require_types();
    var Environments = class {
      constructor(inner) {
        _Environments_inner.set(this, void 0);
        __classPrivateFieldSet(this, _Environments_inner, inner, "f");
      }
      /**
       * Get environment variables belonging to an Environment.
       */
      getVariables(environmentId) {
        return __awaiter(this, void 0, void 0, function* () {
          const invocationConfig = {
            invocation: {
              clientId: __classPrivateFieldGet(this, _Environments_inner, "f").id,
              parameters: {
                name: "EnvironmentsGetVariables",
                parameters: {
                  environment_id: environmentId
                }
              }
            }
          };
          return JSON.parse(yield __classPrivateFieldGet(this, _Environments_inner, "f").invoke(invocationConfig), types_js_1.ReviverFunc);
        });
      }
    };
    exports.Environments = Environments;
    _Environments_inner = /* @__PURE__ */ new WeakMap();
  }
});

// node_modules/@1password/sdk/dist/groups.js
var require_groups = __commonJS({
  "node_modules/@1password/sdk/dist/groups.js"(exports) {
    "use strict";
    var __awaiter = exports && exports.__awaiter || function(thisArg, _arguments, P, generator) {
      function adopt(value) {
        return value instanceof P ? value : new P(function(resolve2) {
          resolve2(value);
        });
      }
      return new (P || (P = Promise))(function(resolve2, reject) {
        function fulfilled(value) {
          try {
            step(generator.next(value));
          } catch (e) {
            reject(e);
          }
        }
        function rejected(value) {
          try {
            step(generator["throw"](value));
          } catch (e) {
            reject(e);
          }
        }
        function step(result) {
          result.done ? resolve2(result.value) : adopt(result.value).then(fulfilled, rejected);
        }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
      });
    };
    var __classPrivateFieldSet = exports && exports.__classPrivateFieldSet || function(receiver, state, value, kind, f) {
      if (kind === "m") throw new TypeError("Private method is not writable");
      if (kind === "a" && !f) throw new TypeError("Private accessor was defined without a setter");
      if (typeof state === "function" ? receiver !== state || !f : !state.has(receiver)) throw new TypeError("Cannot write private member to an object whose class did not declare it");
      return kind === "a" ? f.call(receiver, value) : f ? f.value = value : state.set(receiver, value), value;
    };
    var __classPrivateFieldGet = exports && exports.__classPrivateFieldGet || function(receiver, state, kind, f) {
      if (kind === "a" && !f) throw new TypeError("Private accessor was defined without a getter");
      if (typeof state === "function" ? receiver !== state || !f : !state.has(receiver)) throw new TypeError("Cannot read private member from an object whose class did not declare it");
      return kind === "m" ? f : kind === "a" ? f.call(receiver) : f ? f.value : state.get(receiver);
    };
    var _Groups_inner;
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.Groups = void 0;
    var types_js_1 = require_types();
    var Groups = class {
      constructor(inner) {
        _Groups_inner.set(this, void 0);
        __classPrivateFieldSet(this, _Groups_inner, inner, "f");
      }
      /**
       * Get a group by its ID and parameters.
       */
      get(groupId, groupParams) {
        return __awaiter(this, void 0, void 0, function* () {
          const invocationConfig = {
            invocation: {
              clientId: __classPrivateFieldGet(this, _Groups_inner, "f").id,
              parameters: {
                name: "GroupsGet",
                parameters: {
                  group_id: groupId,
                  group_params: groupParams
                }
              }
            }
          };
          return JSON.parse(yield __classPrivateFieldGet(this, _Groups_inner, "f").invoke(invocationConfig), types_js_1.ReviverFunc);
        });
      }
    };
    exports.Groups = Groups;
    _Groups_inner = /* @__PURE__ */ new WeakMap();
  }
});

// node_modules/@1password/sdk/dist/client.js
var require_client = __commonJS({
  "node_modules/@1password/sdk/dist/client.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.Client = void 0;
    var secrets_js_1 = require_secrets();
    var items_js_1 = require_items();
    var vaults_js_1 = require_vaults();
    var environments_js_1 = require_environments();
    var groups_js_1 = require_groups();
    var Client = class {
      constructor(innerClient) {
        this.secrets = new secrets_js_1.Secrets(innerClient);
        this.items = new items_js_1.Items(innerClient);
        this.vaults = new vaults_js_1.Vaults(innerClient);
        this.environments = new environments_js_1.Environments(innerClient);
        this.groups = new groups_js_1.Groups(innerClient);
      }
    };
    exports.Client = Client;
  }
});

// node_modules/@1password/sdk/dist/shared_lib_core.js
var require_shared_lib_core = __commonJS({
  "node_modules/@1password/sdk/dist/shared_lib_core.js"(exports) {
    "use strict";
    var __createBinding = exports && exports.__createBinding || (Object.create ? (function(o, m, k, k2) {
      if (k2 === void 0) k2 = k;
      var desc = Object.getOwnPropertyDescriptor(m, k);
      if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
        desc = { enumerable: true, get: function() {
          return m[k];
        } };
      }
      Object.defineProperty(o, k2, desc);
    }) : (function(o, m, k, k2) {
      if (k2 === void 0) k2 = k;
      o[k2] = m[k];
    }));
    var __setModuleDefault = exports && exports.__setModuleDefault || (Object.create ? (function(o, v) {
      Object.defineProperty(o, "default", { enumerable: true, value: v });
    }) : function(o, v) {
      o["default"] = v;
    });
    var __importStar = exports && exports.__importStar || /* @__PURE__ */ (function() {
      var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function(o2) {
          var ar = [];
          for (var k in o2) if (Object.prototype.hasOwnProperty.call(o2, k)) ar[ar.length] = k;
          return ar;
        };
        return ownKeys(o);
      };
      return function(mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) {
          for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        }
        __setModuleDefault(result, mod);
        return result;
      };
    })();
    var __awaiter = exports && exports.__awaiter || function(thisArg, _arguments, P, generator) {
      function adopt(value) {
        return value instanceof P ? value : new P(function(resolve2) {
          resolve2(value);
        });
      }
      return new (P || (P = Promise))(function(resolve2, reject) {
        function fulfilled(value) {
          try {
            step(generator.next(value));
          } catch (e) {
            reject(e);
          }
        }
        function rejected(value) {
          try {
            step(generator["throw"](value));
          } catch (e) {
            reject(e);
          }
        }
        function step(result) {
          result.done ? resolve2(result.value) : adopt(result.value).then(fulfilled, rejected);
        }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
      });
    };
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.SharedLibCore = void 0;
    var fs = __importStar(__require("fs"));
    var os = __importStar(__require("os"));
    var path = __importStar(__require("path"));
    var errors_1 = require_errors();
    var find1PasswordLibPath = () => {
      const platform = os.platform();
      const appRoot = path.dirname(process.execPath);
      let searchPaths = [];
      switch (platform) {
        case "darwin":
          searchPaths = [
            "/Applications/1Password.app/Contents/Frameworks/libop_sdk_ipc_client.dylib",
            path.join(os.homedir(), "/Applications/1Password.app/Contents/Frameworks/libop_sdk_ipc_client.dylib")
          ];
          break;
        case "linux":
          searchPaths = [
            "/usr/bin/1password/libop_sdk_ipc_client.so",
            "/opt/1Password/libop_sdk_ipc_client.so",
            "/snap/bin/1password/libop_sdk_ipc_client.so"
          ];
          break;
        case "win32":
          searchPaths = [
            path.join(os.homedir(), "/AppData/Local/1Password/op_sdk_ipc_client.dll"),
            "C:/Program Files/1Password/app/8/op_sdk_ipc_client.dll",
            "C:/Program Files (x86)/1Password/app/8/op_sdk_ipc_client.dll",
            path.join(os.homedir(), "/AppData/Local/1Password/app/8/op_sdk_ipc_client.dll")
          ];
          break;
        default:
          throw new Error(`Unsupported platform: ${platform}`);
      }
      for (const addonPath of searchPaths) {
        if (fs.existsSync(addonPath)) {
          return addonPath;
        }
      }
      throw new Error("1Password desktop application not found");
    };
    var SharedLibCore = class {
      constructor(accountName) {
        this.lib = null;
        try {
          const libPath = find1PasswordLibPath();
          const moduleStub = { exports: {} };
          process.dlopen(moduleStub, libPath);
          if (typeof moduleStub === "object" && moduleStub !== null && typeof moduleStub.exports === "object" && moduleStub.exports !== null && "sendMessage" in moduleStub.exports && typeof moduleStub.exports.sendMessage === "function") {
            this.lib = moduleStub.exports;
          } else {
            throw new Error("Failed to initialize native library: sendMessage function not found on module.");
          }
        } catch (e) {
          console.error("A critical error occurred while loading the native addon:", e);
          this.lib = null;
        }
        this.acccountName = accountName;
      }
      /**
       * callSharedLibrary - send string to native function, receive string back.
       */
      callSharedLibrary(input, operation_type) {
        return __awaiter(this, void 0, void 0, function* () {
          if (!this.lib) {
            throw new Error("Native library is not available.");
          }
          if (!input || input.length === 0) {
            throw new Error("internal: empty input");
          }
          const inputEncoded = Buffer.from(input, "utf8").toString("base64");
          const req = {
            account_name: this.acccountName,
            kind: operation_type,
            payload: inputEncoded
          };
          const inputBuf = Buffer.from(JSON.stringify(req), "utf8");
          const nativeResponse = yield this.lib.sendMessage(inputBuf);
          if (!(nativeResponse instanceof Uint8Array)) {
            throw new Error(`Native function returned an unexpected type. Expected Uint8Array, got ${typeof nativeResponse}`);
          }
          const respString = new TextDecoder().decode(nativeResponse);
          const response = JSON.parse(respString);
          if (response.success) {
            const decodedPayload = Buffer.from(response.payload).toString("utf8");
            return decodedPayload;
          } else {
            const errorMessage = Array.isArray(response.payload) ? String.fromCharCode(...response.payload) : JSON.stringify(response.payload);
            (0, errors_1.throwError)(errorMessage);
          }
        });
      }
      // Core interface implementation
      initClient(config) {
        return __awaiter(this, void 0, void 0, function* () {
          return this.callSharedLibrary(config, "init_client");
        });
      }
      // eslint-disable-next-line @typescript-eslint/require-await
      initClientOidc(config, _fetcher) {
        return __awaiter(this, void 0, void 0, function* () {
          throw new Error("OIDC authentication is not supported with desktop auth");
        });
      }
      invoke(invokeConfigBytes) {
        return __awaiter(this, void 0, void 0, function* () {
          return this.callSharedLibrary(invokeConfigBytes, "invoke");
        });
      }
      releaseClient(clientId) {
        this.callSharedLibrary(clientId, "release_client").catch((err) => {
          console.warn("failed to release client:", err);
        });
      }
    };
    exports.SharedLibCore = SharedLibCore;
  }
});

// node_modules/@1password/sdk/dist/client_builder.js
var require_client_builder = __commonJS({
  "node_modules/@1password/sdk/dist/client_builder.js"(exports) {
    "use strict";
    var __awaiter = exports && exports.__awaiter || function(thisArg, _arguments, P, generator) {
      function adopt(value) {
        return value instanceof P ? value : new P(function(resolve2) {
          resolve2(value);
        });
      }
      return new (P || (P = Promise))(function(resolve2, reject) {
        function fulfilled(value) {
          try {
            step(generator.next(value));
          } catch (e) {
            reject(e);
          }
        }
        function rejected(value) {
          try {
            step(generator["throw"](value));
          } catch (e) {
            reject(e);
          }
        }
        function step(result) {
          result.done ? resolve2(result.value) : adopt(result.value).then(fulfilled, rejected);
        }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
      });
    };
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.createClientWithCore = void 0;
    var core_js_1 = require_core();
    var configuration_js_1 = require_configuration();
    var client_js_1 = require_client();
    var shared_lib_core_js_1 = require_shared_lib_core();
    var finalizationRegistry = new FinalizationRegistry((heldClient) => {
      heldClient.core.releaseClient(heldClient.id);
    });
    var createClientWithCore = (config, core) => __awaiter(void 0, void 0, void 0, function* () {
      if (!config.auth && !config.oidcFetcher) {
        throw new Error("createClient requires either `auth` (service account token) or `oidcFetcher` (workload identity).");
      }
      if (config.oidcFetcher && !config.workloadDetails) {
        throw new Error("`oidcFetcher` (workload identity) requires `workloadDetails` to be set.");
      }
      const authConfig = (0, configuration_js_1.clientAuthConfig)(config);
      if (authConfig.accountName) {
        core.setInner(new shared_lib_core_js_1.SharedLibCore(authConfig.accountName));
      }
      const clientId = config.oidcFetcher ? yield core.initClientOidc(authConfig, config.oidcFetcher) : yield core.initClient(authConfig);
      const inner = new core_js_1.InnerClient(parseInt(clientId, 10), core, authConfig);
      const client = new client_js_1.Client(inner);
      finalizationRegistry.register(client, inner);
      return client;
    });
    exports.createClientWithCore = createClientWithCore;
  }
});

// node_modules/@1password/sdk/dist/sdk.js
var require_sdk = __commonJS({
  "node_modules/@1password/sdk/dist/sdk.js"(exports) {
    "use strict";
    var __createBinding = exports && exports.__createBinding || (Object.create ? (function(o, m, k, k2) {
      if (k2 === void 0) k2 = k;
      var desc = Object.getOwnPropertyDescriptor(m, k);
      if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
        desc = { enumerable: true, get: function() {
          return m[k];
        } };
      }
      Object.defineProperty(o, k2, desc);
    }) : (function(o, m, k, k2) {
      if (k2 === void 0) k2 = k;
      o[k2] = m[k];
    }));
    var __exportStar = exports && exports.__exportStar || function(m, exports2) {
      for (var p in m) if (p !== "default" && !Object.prototype.hasOwnProperty.call(exports2, p)) __createBinding(exports2, m, p);
    };
    var __awaiter = exports && exports.__awaiter || function(thisArg, _arguments, P, generator) {
      function adopt(value) {
        return value instanceof P ? value : new P(function(resolve2) {
          resolve2(value);
        });
      }
      return new (P || (P = Promise))(function(resolve2, reject) {
        function fulfilled(value) {
          try {
            step(generator.next(value));
          } catch (e) {
            reject(e);
          }
        }
        function rejected(value) {
          try {
            step(generator["throw"](value));
          } catch (e) {
            reject(e);
          }
        }
        function step(result) {
          result.done ? resolve2(result.value) : adopt(result.value).then(fulfilled, rejected);
        }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
      });
    };
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.createClient = exports.DesktopAuth = exports.Secrets = exports.DEFAULT_INTEGRATION_VERSION = exports.DEFAULT_INTEGRATION_NAME = void 0;
    var core_js_1 = require_core();
    var client_builder_js_1 = require_client_builder();
    exports.DEFAULT_INTEGRATION_NAME = "Unknown";
    exports.DEFAULT_INTEGRATION_VERSION = "Unknown";
    var secrets_js_1 = require_secrets();
    Object.defineProperty(exports, "Secrets", { enumerable: true, get: function() {
      return secrets_js_1.Secrets;
    } });
    var configuration_js_1 = require_configuration();
    Object.defineProperty(exports, "DesktopAuth", { enumerable: true, get: function() {
      return configuration_js_1.DesktopAuth;
    } });
    __exportStar(require_client(), exports);
    __exportStar(require_errors(), exports);
    __exportStar(require_types(), exports);
    var createClient = (config) => __awaiter(void 0, void 0, void 0, function* () {
      return (0, client_builder_js_1.createClientWithCore)(config, new core_js_1.SharedCore());
    });
    exports.createClient = createClient;
  }
});

// src/broker/main.ts
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

// src/paths.ts
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

// src/version.ts
var VERSION = "0.2.2";
var PROTOCOL_VERSION = 2;

// src/paths.ts
var STATE_DIR_NAME = "1password-bridge";
var MAX_SOCKET_PATH_BYTES = 100;
var SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
function resolveStateDir(env2 = process.env) {
  const pluginData = env2.CLAUDE_PLUGIN_DATA;
  if (pluginData !== void 0 && pluginData !== "") {
    return resolve(pluginData);
  }
  const xdgState = env2.XDG_STATE_HOME;
  if (xdgState !== void 0 && isAbsolute(xdgState)) {
    return join(xdgState, STATE_DIR_NAME);
  }
  const home = env2.HOME !== void 0 && env2.HOME !== "" ? env2.HOME : homedir();
  return join(home, ".local", "state", STATE_DIR_NAME);
}
function isSessionId(value) {
  return SESSION_ID_PATTERN.test(value);
}
function sessionsDir(stateDir2) {
  return join(stateDir2, "sessions");
}
function sessionDir(stateDir2, sessionId) {
  if (!isSessionId(sessionId)) {
    throw new TypeError(`Invalid session id ${JSON.stringify(sessionId)}`);
  }
  return join(sessionsDir(stateDir2), sessionId);
}
function boardDir(stateDir2, id) {
  return join(sessionDir(stateDir2, id), "board");
}
function maskedMarkerPath(stateDir2, id) {
  return join(sessionDir(stateDir2, id), "masked");
}
function sessionInfoPath(stateDir2, id) {
  return join(sessionDir(stateDir2, id), "session.json");
}
function socketPath(stateDir2, uid, tmp, runtimeDir) {
  const name = `broker-v${PROTOCOL_VERSION}.sock`;
  const preferred = join(stateDir2, "run", name);
  if (Buffer.byteLength(preferred) <= MAX_SOCKET_PATH_BYTES) {
    return preferred;
  }
  if (runtimeDir !== void 0 && isAbsolute(runtimeDir)) {
    const runtime = join(runtimeDir, STATE_DIR_NAME, name);
    if (Buffer.byteLength(runtime) <= MAX_SOCKET_PATH_BYTES) {
      return runtime;
    }
  }
  return join(tmp, `${STATE_DIR_NAME}-${uid}`, name);
}

// src/broker/dialog.ts
import { spawn } from "node:child_process";
import { join as join2 } from "node:path";

// src/strings.ts
var SDK_INTEGRATION_SETTING = "Settings > Developer > Integrate with 1Password SDKs";
var STRINGS = {
  en: {
    windowTitle: "Claude Code requests a secret",
    session: "Session",
    sessionId: "Session ID",
    account: "Account",
    vault: "Vault",
    item: "Item",
    section: "Section",
    field: "Field",
    type: "Type",
    agent: "Agent",
    startDir: "Started in",
    ticket: "Ticket",
    command: "Command",
    commandLiteral: "Command naming this ticket",
    expand: "Show all",
    approve: "Approve",
    deny: "Deny",
    notePlain: "not a secret, returned in plain text",
    noteShort: "secret shorter than 8 characters, NOT masked",
    noteMasked: "secret, masked in Bash output"
  },
  uk: {
    windowTitle: "Claude Code запитує секрет",
    session: "Сесія",
    sessionId: "ID сесії",
    account: "Акаунт",
    vault: "Сховище",
    item: "Айтем",
    section: "Секція",
    field: "Поле",
    type: "Тип",
    agent: "Агент",
    startDir: "Стартова тека",
    ticket: "Квиток",
    command: "Команда",
    commandLiteral: "Команда з цим квитком",
    expand: "Показати повністю",
    approve: "Погодити",
    deny: "Відхилити",
    notePlain: "не секрет, видається відкрито",
    noteShort: "секрет коротший за 8 символів, НЕ маскується",
    noteMasked: "секрет, буде замасковано у виводі Bash"
  }
};
function strings(lang) {
  return lang === "uk" ? STRINGS.uk : STRINGS.en;
}

// src/classify.ts
var MIN_MASK_LENGTH = 8;
var MASKED_TYPES = /* @__PURE__ */ new Set([
  "Concealed",
  "CreditCardNumber",
  "SshKey",
  "Totp",
  "Unsupported"
]);
var PLAIN_ATTRIBUTES = /* @__PURE__ */ new Set(["otp", "public-key", "fingerprint"]);
function classify(p) {
  let secret;
  if (p.notes === true) {
    secret = true;
  } else if (p.attribute !== void 0 && PLAIN_ATTRIBUTES.has(p.attribute)) {
    secret = false;
  } else {
    secret = p.fieldType !== void 0 && MASKED_TYPES.has(p.fieldType);
  }
  const masked = secret && p.value.length >= MIN_MASK_LENGTH;
  return { masked, short: secret && !masked };
}
function typeLabel(fieldType, kind, lang) {
  const table = strings(lang);
  const note = kind.masked ? table.noteMasked : kind.short ? table.noteShort : table.notePlain;
  return `${fieldType} · ${note}`;
}

// src/broker/dialog.ts
var MAX_STDOUT_BYTES = 64 * 1024;
var COMMAND_PREVIEW_CHARS = 100;
var ZENITY_COMMAND_LINES = 40;
function commandPreview(command) {
  const lines = command.split("\n");
  const first = Array.from(lines[0] ?? "");
  const cut = first.length > COMMAND_PREVIEW_CHARS;
  const shown = cut ? first.slice(0, COMMAND_PREVIEW_CHARS).join("") : first.join("");
  return cut || lines.length > 1 ? `${shown}…` : shown;
}
function cappedLines(text, max = ZENITY_COMMAND_LINES) {
  const lines = text.split("\n");
  return lines.length <= max ? text : [...lines.slice(0, max), "…"].join("\n");
}
var HIDDEN_CHARS = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu;
var LINE_BREAKS = /\r\n|[\r\n\u{2028}\u{2029}]/gu;
function shownText(text, field) {
  const flat = field === "reason" ? text.replace(LINE_BREAKS, " ").replace(/\t/g, " ") : text;
  const keep = field === "command" ? "\n	" : field === "cwd" ? "	" : "";
  return flat.replace(
    HIDDEN_CHARS,
    (c) => keep.includes(c) ? c : `\\u{${(c.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, "0")}}`
  );
}
var runCommand = (command, args, timeoutMs, signal) => new Promise((resolve2) => {
  if (signal?.aborted === true) {
    resolve2({ kind: "error" });
    return;
  }
  let settled = false;
  let timedOut = false;
  let stdout = "";
  const settle = (result) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
    resolve2(result);
  };
  const child = spawn(command, args, { stdio: ["ignore", "pipe", "ignore"] });
  const timer = timeoutMs === void 0 ? void 0 : setTimeout(() => {
    timedOut = true;
    child.kill("SIGKILL");
  }, timeoutMs);
  const onAbort = () => {
    child.kill("SIGKILL");
    settle({ kind: "error" });
  };
  signal?.addEventListener("abort", onAbort, { once: true });
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    if (stdout.length < MAX_STDOUT_BYTES) stdout += chunk;
  });
  child.on("error", (err) => settle(err.code === "ENOENT" ? { kind: "missing" } : { kind: "error" }));
  child.on("close", (code) => {
    if (timedOut) settle({ kind: "timeout" });
    else if (code !== null) settle({ kind: "exit", code, stdout });
    else settle({ kind: "error" });
  });
});
function pangoEscape(s) {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}
function zenityEscape(s) {
  return pangoEscape(s).replace(/\\/g, "\\\\");
}
function zenityText(a) {
  const rows = a.rows.map(([label, value, mono]) => {
    const shown = zenityEscape(value);
    return `<b>${zenityEscape(label)}</b>  ${mono === true ? `<tt>${shown}</tt>` : shown}`;
  });
  const commands = a.commands.map((c) => {
    const heading = zenityEscape(c.literal ? a.labels.literal : a.labels.command);
    return `<b>${heading}</b>  ${zenityEscape(c.cwd)}
<tt>${zenityEscape(cappedLines(c.full))}</tt>`;
  });
  return [rows.join("\n"), zenityEscape(a.reason), ...commands].join("\n\n");
}
async function askMac(run, pluginRoot2, a, signal) {
  const script = join2(pluginRoot2, "dialog", "macos-window.js");
  const result = await run("osascript", ["-l", "JavaScript", script, JSON.stringify(a)], void 0, signal);
  if (result.kind === "exit" && result.code === 0) {
    const answer = result.stdout.trim();
    if (answer === "approve" || answer === "deny") return answer;
  }
  return "unavailable";
}
async function askZenity(run, a, signal) {
  const args = ["--question", `--title=${a.title}`, `--text=${zenityText(a)}`, `--ok-label=${a.approve}`, `--cancel-label=${a.deny}`, "--width=520"];
  const result = await run("zenity", args, void 0, signal);
  if (result.kind === "exit" && result.code === 0) return "approve";
  if (result.kind === "exit" && result.code === 1) return "deny";
  return "unavailable";
}
function platformDialog(run, platform, pluginRoot2) {
  const closing = new AbortController();
  const show = (a, signal) => {
    if (signal.aborted) return Promise.resolve("unavailable");
    if (platform === "darwin") return askMac(run, pluginRoot2, a, signal);
    if (platform === "linux") return askZenity(run, a, signal);
    return Promise.resolve("unavailable");
  };
  let tail = Promise.resolve();
  return {
    ask(a, signal) {
      if (closing.signal.aborted) return Promise.resolve("unavailable");
      if (signal?.aborted === true) return Promise.resolve("cancelled");
      const both = signal === void 0 ? closing.signal : AbortSignal.any([closing.signal, signal]);
      const settle = (result) => closing.signal.aborted ? "unavailable" : signal?.aborted === true ? "cancelled" : result;
      const answer = tail.then(() => both.aborted ? "cancelled" : show(a, both)).then(settle).catch(() => "unavailable");
      tail = answer;
      if (signal === void 0) return answer;
      let onAbort = () => {
      };
      const cancelled = new Promise((resolve2) => {
        onAbort = () => resolve2(settle("cancelled"));
        signal.addEventListener("abort", onAbort, { once: true });
      });
      return Promise.race([answer, cancelled]).finally(() => signal.removeEventListener("abort", onAbort));
    },
    close() {
      closing.abort();
    }
  };
}
function ticketApproval(d, lang) {
  const t = strings(lang);
  const rows = [];
  if (d.session.title !== void 0 && d.session.title !== "") rows.push([t.session, d.session.title]);
  rows.push([t.sessionId, d.session.id, true]);
  rows.push([t.agent, d.agent.id === "main" ? "main" : shownText(`subagent · ${d.agent.type ?? d.agent.id}`, "line")]);
  if (d.session.startDir !== void 0 && d.session.startDir !== "") rows.push([t.startDir, shownText(d.session.startDir, "cwd"), true]);
  rows.push([t.account, d.account]);
  rows.push([t.vault, d.vault]);
  rows.push([t.item, `${d.item} · ${d.category}`]);
  if (d.section !== void 0 && d.section !== "") rows.push([t.section, d.section]);
  rows.push([t.field, d.field]);
  rows.push([t.type, typeLabel(d.fieldType, d.kind, lang)]);
  rows.push([t.ticket, d.ticket, true]);
  return {
    title: t.windowTitle,
    reason: shownText(d.reason, "reason"),
    rows,
    commands: d.commands.map((c) => {
      const command = shownText(c.command, "command");
      return { short: commandPreview(command), full: command, cwd: shownText(c.cwd, "cwd"), literal: c.literal };
    }),
    labels: { command: t.command, literal: t.commandLiteral, expand: t.expand },
    approve: t.approve,
    deny: t.deny
  };
}

// src/broker/onepassword.ts
var INTEGRATION_NAME = "1Password Bridge";
var ACTIVE_ITEMS = { type: "ByState", content: { active: true, archived: false } };
function accountClient(client) {
  return {
    async listVaults() {
      const vaults = await client.vaults.list();
      return vaults.map((v) => ({ id: v.id, title: v.title }));
    },
    async listItems(vaultId) {
      const items = await client.items.list(vaultId, ACTIVE_ITEMS);
      return items.map((i) => ({ id: i.id, title: i.title, category: i.category }));
    },
    async getItem(vaultId, itemId) {
      const item = await client.items.get(vaultId, itemId);
      return {
        id: item.id,
        title: item.title,
        category: item.category,
        notes: item.notes ?? "",
        sections: item.sections.map((s) => ({ id: s.id, title: s.title ?? "" })),
        fields: item.fields.map((f) => {
          const field = { id: f.id, title: f.title, fieldType: f.fieldType, value: f.value };
          if (f.sectionId !== void 0 && f.sectionId !== null) field.sectionId = f.sectionId;
          if (f.details !== void 0 && f.details !== null) field.details = f.details;
          return field;
        })
      };
    }
  };
}
async function loadSdk() {
  const sdk = await Promise.resolve().then(() => __toESM(require_sdk(), 1));
  return { DesktopAuth: sdk.DesktopAuth, createClient: sdk.createClient };
}
async function connectDesktop(account, load = loadSdk) {
  const sdk = await load();
  const client = await sdk.createClient({
    auth: new sdk.DesktopAuth(account),
    integrationName: INTEGRATION_NAME,
    integrationVersion: VERSION
  });
  return accountClient(client);
}

// src/broker/service.ts
import { appendFileSync, chmodSync, lstatSync, mkdirSync as mkdirSync2, statSync as statSync2, truncateSync, unlinkSync } from "node:fs";
import { connect, createServer } from "node:net";
import { dirname as dirname2, join as join4 } from "node:path";

// src/board.ts
import { readdirSync, readFileSync as readFileSync2, renameSync as renameSync2, rmSync as rmSync2, statSync, utimesSync as utimesSync2 } from "node:fs";
import { join as join3 } from "node:path";

// src/session-files.ts
import { mkdirSync, readFileSync, renameSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
function errCode(err) {
  return err !== null && typeof err === "object" ? err.code : void 0;
}
function writeAtomic(path, text) {
  mkdirSync(dirname(path), { recursive: true, mode: 448 });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, text, { mode: 384 });
  renameSync(tmp, path);
}
function readSessionInfo(stateDir2, id) {
  try {
    const parsed = JSON.parse(readFileSync(sessionInfoPath(stateDir2, id), "utf8"));
    const cwd = parsed !== null && typeof parsed === "object" ? parsed.cwd : void 0;
    return typeof cwd === "string" ? { cwd } : {};
  } catch {
    return {};
  }
}
function readMarker(stateDir2, id) {
  let text;
  try {
    text = readFileSync(maskedMarkerPath(stateDir2, id), "utf8");
  } catch (err) {
    if (errCode(err) === "ENOENT") return void 0;
    throw err;
  }
  return text.split("\n").filter((line) => line !== "");
}
function markTicket(stateDir2, id, ticket) {
  const ids2 = readMarker(stateDir2, id) ?? [];
  if (!ids2.includes(ticket)) writeAtomic(maskedMarkerPath(stateDir2, id), `${[...ids2, ticket].join("\n")}
`);
}
function unmarkTickets(stateDir2, id, tickets) {
  const ids2 = readMarker(stateDir2, id);
  if (ids2 === void 0) return;
  const left = ids2.filter((t) => !tickets.includes(t));
  if (left.length === ids2.length) return;
  if (left.length === 0) rmSync(maskedMarkerPath(stateDir2, id), { force: true });
  else writeAtomic(maskedMarkerPath(stateDir2, id), `${left.join("\n")}
`);
}

// src/ticket-lifetime.ts
var TICKET_TTL_MS = 10 * 60 * 1e3;

// src/board.ts
var STALE_GRACE_MS = 3e4;
var MAX_SCAN_ATTEMPTS = 5;
var BACKGROUND_PREFIX = "bg-";
function errCode2(err) {
  return err !== null && typeof err === "object" ? err.code : void 0;
}
function parseEntry(text) {
  let v;
  try {
    v = JSON.parse(text);
  } catch {
    return void 0;
  }
  if (v === null || typeof v !== "object") return void 0;
  const e = v;
  const { agent_id, agent_type, tool_use_id, command, cwd, startedAt, timeoutMs } = e;
  if (typeof agent_id !== "string" || typeof tool_use_id !== "string" || typeof command !== "string" || typeof cwd !== "string") return void 0;
  if (typeof startedAt !== "number" || typeof timeoutMs !== "number") return void 0;
  if (agent_type !== void 0 && typeof agent_type !== "string") return void 0;
  const entry = { agent_id, tool_use_id, command, cwd, startedAt, timeoutMs };
  if (agent_type !== void 0) entry.agent_type = agent_type;
  return entry;
}
function listNames(dir) {
  try {
    return readdirSync(dir).filter((name) => name.endsWith(".json"));
  } catch (err) {
    if (errCode2(err) === "ENOENT") return [];
    throw err;
  }
}
function sameNames(a, b) {
  const names = new Set(a);
  return a.length === b.length && b.every((name) => names.has(name));
}
function list(stateDir2, session) {
  const dir = boardDir(stateDir2, session);
  const seen = /* @__PURE__ */ new Map();
  for (let attempt = 0; attempt < MAX_SCAN_ATTEMPTS; attempt += 1) {
    const names = listNames(dir);
    const pass = [];
    let vanished = false;
    for (const name of names) {
      const path = join3(dir, name);
      let entry;
      try {
        entry = parseEntry(readFileSync2(path, "utf8"));
      } catch (err) {
        if (errCode2(err) !== "ENOENT") throw err;
        vanished = true;
        continue;
      }
      const base = name.slice(0, -".json".length);
      pass.push({ path, taskId: base.startsWith(BACKGROUND_PREFIX) ? base.slice(BACKGROUND_PREFIX.length) : void 0, entry });
    }
    if (!vanished && sameNames(names, listNames(dir))) return pass;
    for (const item of pass) seen.set(item.entry === void 0 ? `path:${item.path}` : `id:${item.entry.tool_use_id}`, item);
  }
  return [...seen.values()];
}
function stale(entry, now) {
  return now - entry.startedAt > Math.max(entry.timeoutMs, TICKET_TTL_MS) + STALE_GRACE_MS;
}
function readBoard(stateDir2, session, now) {
  const out = [];
  for (const { taskId, entry } of list(stateDir2, session)) {
    if (entry === void 0) continue;
    const background = taskId !== void 0;
    if (!background && stale(entry, now)) continue;
    out.push({ ...entry, background });
  }
  return out;
}

// src/protocol.ts
var MAX_TICKETS = 5;
var TICKET_ID_PATTERN = /^tkt_[a-z2-7]{16}$/;
var ACKS = ["received", "delivered", "not_delivered"];
var FAILURE_CODES = [
  "denied",
  "no_dialog",
  "not_found",
  "ambiguous",
  "bad_ref",
  "integration_off",
  "auth_denied",
  "auth_timeout",
  "expired",
  "busy",
  "not_owner",
  "other_agent",
  "no_command",
  "unknown",
  "used",
  "voided",
  "field_gone",
  // The broker lost its socket path to another broker; broker-client reconnects and retries once.
  "displaced",
  "no_app",
  "internal"
];
var RELEASE_RESULTS = ["voided", "in_flight", "unmasked", "mask_kept", "final", "unknown", "not_owner"];
var MAX_LINE_BYTES = 1024 * 1024;
var MAX_OUTPUT_BYTES = 64 * 1024 * 1024;
var FrameError = class extends Error {
  code = "EFRAME";
  constructor(message) {
    super(message);
    this.name = "FrameError";
  }
};
function encodeLine(message) {
  return `${JSON.stringify(message)}
`;
}
function readLine(stream, maxBytes = MAX_LINE_BYTES) {
  return new Promise((resolve2, reject) => {
    const chunks = [];
    let size = 0;
    const finish = (settle) => {
      stream.off("data", onData);
      stream.off("end", onEnd);
      stream.off("close", onEnd);
      stream.off("error", onEnd);
      stream.pause();
      settle();
    };
    const onData = (chunk) => {
      const bytes = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
      const end = bytes.indexOf(10);
      if (end >= 0 && size + end <= maxBytes) {
        chunks.push(bytes.subarray(0, end));
        finish(() => resolve2(Buffer.concat(chunks).toString("utf8")));
        return;
      }
      size += end >= 0 ? end : bytes.length;
      if (size > maxBytes) {
        finish(() => reject(new FrameError(`No newline within ${maxBytes} bytes`)));
        return;
      }
      chunks.push(bytes);
    };
    const onEnd = () => finish(() => resolve2(null));
    stream.on("data", onData);
    stream.once("end", onEnd);
    stream.once("close", onEnd);
    stream.once("error", onEnd);
  });
}
function lineReader(stream, maxBytes = MAX_LINE_BYTES) {
  let max = maxBytes;
  const lines = [];
  let partial = [];
  let partialSize = 0;
  let ended = false;
  let failure;
  let wake;
  const notify = () => {
    const resolve2 = wake;
    wake = void 0;
    resolve2?.();
  };
  const tooLong = () => {
    failure = new FrameError(`No newline within ${max} bytes`);
    stream.off("data", onData);
    stream.pause();
  };
  const onData = (chunk) => {
    let bytes = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
    for (let end = bytes.indexOf(10); end >= 0; end = bytes.indexOf(10)) {
      if (partialSize + end > max) {
        tooLong();
        notify();
        return;
      }
      partial.push(bytes.subarray(0, end));
      lines.push(Buffer.concat(partial, partialSize + end).toString("utf8"));
      partial = [];
      partialSize = 0;
      bytes = bytes.subarray(end + 1);
    }
    partial.push(bytes);
    partialSize += bytes.length;
    if (partialSize > max) tooLong();
    notify();
  };
  const onEnd = () => {
    ended = true;
    notify();
  };
  stream.on("data", onData);
  stream.once("end", onEnd);
  stream.once("close", onEnd);
  stream.once("error", onEnd);
  return {
    async next() {
      for (; ; ) {
        const line = lines.shift();
        if (line !== void 0 && Buffer.byteLength(line) > max) tooLong();
        else if (line !== void 0) return line;
        if (failure !== void 0) throw failure;
        if (ended) return null;
        await new Promise((resolve2) => {
          wake = resolve2;
        });
      }
    },
    limit(bytes) {
      max = bytes;
      if (failure === void 0 && partialSize > max) {
        tooLong();
        notify();
      }
    }
  };
}
function parseObject(line) {
  let value;
  try {
    value = JSON.parse(line);
  } catch {
    return null;
  }
  return isObject(value) ? value : null;
}
function isObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}
function isString(v) {
  return typeof v === "string";
}
function isOptionalString(v) {
  return v === void 0 || typeof v === "string";
}
function isSession(v) {
  return isString(v) && isSessionId(v);
}
function isTicketId(v) {
  return isString(v) && TICKET_ID_PATTERN.test(v);
}
function parseRequest(line) {
  const m = parseObject(line);
  if (m === null || m["v"] !== PROTOCOL_VERSION) return null;
  const v = PROTOCOL_VERSION;
  switch (m["op"]) {
    case "status":
      return { v, op: "status" };
    case "fields": {
      const { account, ref } = m;
      return isString(account) && isString(ref) ? { v, op: "fields", account, ref } : null;
    }
    case "issue_tickets": {
      const { account, accountLabel, ref, reason, count, session, agent } = m;
      if (!isString(account) || !isString(accountLabel) || !isString(ref) || !isString(reason)) return null;
      if (typeof count !== "number" || !Number.isInteger(count) || count < 1 || count > MAX_TICKETS) return null;
      if (!isObject(session) || !isSession(session["id"]) || !isOptionalString(session["title"])) return null;
      if (!isObject(agent) || !isString(agent["id"]) || agent["id"] === "" || !isOptionalString(agent["type"])) return null;
      const title = session["title"];
      const type = agent["type"];
      return {
        v,
        op: "issue_tickets",
        account,
        accountLabel,
        ref,
        reason,
        count,
        session: title === void 0 ? { id: session["id"] } : { id: session["id"], title },
        agent: type === void 0 ? { id: agent["id"] } : { id: agent["id"], type }
      };
    }
    case "redeem": {
      const { ticket, session } = m;
      return isString(ticket) && isSession(session) ? { v, op: "redeem", ticket, session } : null;
    }
    case "mask": {
      const { session, tickets } = m;
      if (!isSession(session) || !Array.isArray(tickets) || !tickets.every(isString) || !Object.hasOwn(m, "output")) return null;
      return { v, op: "mask", session, tickets: [...tickets], output: m["output"] };
    }
    case "release": {
      const { session, tickets } = m;
      if (!isSession(session) || !Array.isArray(tickets) || !tickets.every(isString)) return null;
      return { v, op: "release", session, tickets: [...tickets] };
    }
    case "end_session": {
      const { session } = m;
      return isSession(session) ? { v, op: "end_session", session } : null;
    }
    default:
      return null;
  }
}
function parseField(v) {
  if (!isObject(v)) return null;
  const { id, title, sectionId, section, type, masked } = v;
  if (!isString(id) || !isString(title) || !isString(type) || typeof masked !== "boolean") return null;
  if (!isOptionalString(sectionId) || !isOptionalString(section)) return null;
  const field = { id, title, type, masked };
  if (sectionId !== void 0) field.sectionId = sectionId;
  if (section !== void 0) field.section = section;
  return field;
}
function parseResponse(line, op) {
  const m = parseObject(line);
  if (m === null) return null;
  if (m["ok"] === false) {
    const { code, message } = m;
    return FAILURE_CODES.includes(code) && isString(message) ? { ok: false, code, message } : null;
  }
  if (m["ok"] !== true || m["op"] !== op) return null;
  switch (op) {
    case "status": {
      const { accounts, exitsAt } = m;
      if (!Array.isArray(accounts) || !isString(exitsAt)) return null;
      const list2 = [];
      for (const a of accounts) {
        if (!isObject(a) || !isString(a["account"]) || typeof a["warm"] !== "boolean") return null;
        list2.push({ account: a["account"], warm: a["warm"] });
      }
      return { ok: true, op, accounts: list2, exitsAt };
    }
    case "fields": {
      const { vault, item, fields } = m;
      if (!isString(vault) || !isObject(item) || !isString(item["title"]) || !isString(item["category"]) || !Array.isArray(fields)) return null;
      const list2 = [];
      for (const f of fields) {
        const field = parseField(f);
        if (field === null) return null;
        list2.push(field);
      }
      return { ok: true, op, vault, item: { title: item["title"], category: item["category"] }, fields: list2 };
    }
    case "issue_tickets": {
      const { tickets, expiresAt, field } = m;
      if (!Array.isArray(tickets) || !tickets.every(isTicketId) || !isString(expiresAt) || !isObject(field)) return null;
      const { vault, item, field: title, type, masked, short } = field;
      if (!isString(vault) || !isString(item) || !isString(title) || !isString(type)) return null;
      if (typeof masked !== "boolean" || typeof short !== "boolean") return null;
      return { ok: true, op, tickets: [...tickets], expiresAt, field: { vault, item, field: title, type, masked, short } };
    }
    case "redeem": {
      const value = m["value"];
      return isString(value) ? { ok: true, op, value } : null;
    }
    case "mask": {
      const { known, changed, missing } = m;
      if (typeof known !== "boolean" || typeof changed !== "boolean" || !Object.hasOwn(m, "output")) return null;
      if (!Array.isArray(missing) || !missing.every(isString)) return null;
      return { ok: true, op, known, changed, output: m["output"], missing: [...missing] };
    }
    case "release": {
      const results = m["results"];
      if (!Array.isArray(results)) return null;
      const list2 = [];
      for (const r of results) {
        if (!isObject(r) || !isString(r["ticket"])) return null;
        const result = r["result"];
        if (!RELEASE_RESULTS.includes(result)) return null;
        list2.push({ ticket: r["ticket"], result });
      }
      return { ok: true, op, results: list2 };
    }
    case "end_session":
      return { ok: true, op };
  }
}
function parseAck(line) {
  if (line === null) return null;
  const m = parseObject(line);
  if (m === null || m["v"] !== PROTOCOL_VERSION) return null;
  const op = m["op"];
  return ACKS.includes(op) ? op : null;
}

// src/ref.ts
var RefError = class extends Error {
  name = "RefError";
};
var SCHEME = /^op:\/\//i;
var FIELD_FORMS = "expected op://<vault>/<item>/[<section>/]<field>, optionally followed by ?attribute=otp|totp|public-key|fingerprint|private-key";
var ITEM_FORMS = "expected op://<vault>/<item>";
var ATTRIBUTES = /* @__PURE__ */ new Map([
  ["otp", "otp"],
  ["totp", "otp"],
  ["public-key", "public-key"],
  ["fingerprint", "fingerprint"],
  ["private-key", "private-key"]
]);
function refused(ref, problem, forms) {
  return new RefError(`Invalid secret reference ${JSON.stringify(ref)}: ${problem}; ${forms}`);
}
function segments(ref, path, forms) {
  const parts = path.split("/");
  if (parts.some((part) => part === "")) {
    throw refused(ref, "a segment is empty", forms);
  }
  return parts;
}
function parseAttribute(ref, query) {
  const params = query.split("&");
  if (params.length !== 1) {
    throw refused(ref, "only one query parameter is accepted", FIELD_FORMS);
  }
  const [param] = params;
  const equals = param.indexOf("=");
  const key = equals === -1 ? param : param.slice(0, equals);
  if (key.toLowerCase() !== "attribute") {
    throw refused(ref, `unknown query parameter ${JSON.stringify(key)}`, FIELD_FORMS);
  }
  const value = equals === -1 ? "" : param.slice(equals + 1);
  const attribute2 = ATTRIBUTES.get(value.toLowerCase());
  if (attribute2 === void 0) {
    throw refused(ref, `unknown attribute ${JSON.stringify(value)}`, FIELD_FORMS);
  }
  return attribute2;
}
function parseFieldRef(ref) {
  if (!SCHEME.test(ref)) {
    throw refused(ref, "the op:// scheme is missing", FIELD_FORMS);
  }
  const rest = ref.replace(SCHEME, "");
  const question = rest.indexOf("?");
  const path = question === -1 ? rest : rest.slice(0, question);
  const parts = segments(ref, path, FIELD_FORMS);
  const attribute2 = question === -1 ? void 0 : parseAttribute(ref, rest.slice(question + 1));
  let result;
  if (parts.length === 3) {
    const [vault, item, field] = parts;
    result = { vault, item, field };
  } else if (parts.length === 4) {
    const [vault, item, section, field] = parts;
    result = { vault, item, section, field };
  } else {
    throw refused(ref, `${parts.length} segments, a field takes 3 or 4`, FIELD_FORMS);
  }
  if (attribute2 !== void 0) {
    result.attribute = attribute2;
  }
  return result;
}
function parseItemRef(ref) {
  if (!SCHEME.test(ref)) {
    throw refused(ref, "the op:// scheme is missing", ITEM_FORMS);
  }
  const rest = ref.replace(SCHEME, "");
  if (rest.includes("?")) {
    throw refused(ref, "an item reference takes no query", ITEM_FORMS);
  }
  const parts = segments(ref, rest, ITEM_FORMS);
  if (parts.length !== 2) {
    throw refused(ref, `${parts.length} segments, an item takes 2`, ITEM_FORMS);
  }
  const [vault, item] = parts;
  return { vault, item };
}

// src/session-lifetime.ts
var SESSION_FORGET_MS = 7 * 24 * 60 * 60 * 1e3;
var FORGET_SCAN_MS = 10 * 60 * 1e3;
var SWEEP_AGE_MS = SESSION_FORGET_MS + 60 * 60 * 1e3;

// src/broker/attribution.ts
var RECHECK_MS = 500;
var ATTRIBUTION_WAIT_MS = 3e4;
function attribute(entries, owner, ticket) {
  if (entries.some((e) => e.agent_id !== owner && e.command.includes(ticket))) return { kind: "refused", code: "not_owner" };
  if (entries.some((e) => e.agent_id !== owner)) return { kind: "pending", code: "other_agent" };
  if (entries.length === 0) return { kind: "pending", code: "no_command" };
  const commands = entries.map((e) => ({ command: e.command, cwd: e.cwd, literal: e.command.includes(ticket) }));
  commands.sort((a, b) => Number(b.literal) - Number(a.literal));
  return { kind: "attributed", commands };
}
function sleep(clock, ms, signal) {
  return new Promise((resolve2) => {
    const onAbort = () => {
      clock.clearTimeout(handle);
      resolve2();
    };
    const handle = clock.setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve2();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
async function attributeWaiting(read, owner, ticket, clock, signal, waitMs = ATTRIBUTION_WAIT_MS, everyMs = RECHECK_MS) {
  const deadline = clock.now() + waitMs;
  for (; ; ) {
    if (signal.aborted) return null;
    const result = attribute(read(), owner, ticket);
    const left = deadline - clock.now();
    if (result.kind !== "pending" || left <= 0) return result;
    await sleep(clock, Math.min(everyMs, left), signal);
  }
}

// src/broker/lookup.ts
var LookupError = class extends Error {
  name = "LookupError";
  code;
  constructor(code, message) {
    super(message);
    this.code = code;
  }
};
var ITEM_ID = /^[a-z0-9]{26}$/;
var NOTES_ID = "notes";
var NOTES_SEGMENTS = /* @__PURE__ */ new Set(["notes", "notesplain"]);
var NOTES_TYPE = "Notes";
function quote(s) {
  return JSON.stringify(s);
}
function matches(list2, segment) {
  const byId = list2.filter((x) => x.id === segment);
  if (byId.length === 1) return byId;
  const lower = segment.toLowerCase();
  const byTitle = list2.filter((x) => x.title !== "" && x.title.toLowerCase() === lower);
  if (byTitle.length <= 1) return byTitle.length === 1 ? byTitle : byId;
  const exact = byTitle.filter((x) => x.title === segment);
  return exact.length === 1 ? exact : byTitle;
}
function ids(list2) {
  return list2.map((x) => x.id).join(", ");
}
async function findVault(client, segment) {
  const found = matches(await client.listVaults(), segment);
  const [vault] = found;
  if (vault === void 0) throw new LookupError("not_found", `No vault ${quote(segment)} in this account`);
  if (found.length > 1) {
    throw new LookupError("ambiguous", `Vault ${quote(segment)} matches ${found.length} vaults (ids ${ids(found)}); use a vault id`);
  }
  return vault;
}
async function findItem(client, vault, segment) {
  if (ITEM_ID.test(segment)) return client.getItem(vault.id, segment);
  const found = matches(await client.listItems(vault.id), segment);
  const [item] = found;
  if (item === void 0) throw new LookupError("not_found", `No item ${quote(segment)} in vault ${quote(vault.title)}`);
  if (found.length > 1) {
    throw new LookupError(
      "ambiguous",
      `Item ${quote(segment)} matches ${found.length} items in vault ${quote(vault.title)} (ids ${ids(found)}); use an item id`
    );
  }
  return client.getItem(vault.id, item.id);
}
function findField(item, ref) {
  let candidates = item.fields;
  let where = `item ${quote(item.title)}`;
  if (ref.section !== void 0) {
    const sections = matches(item.sections, ref.section);
    const [section] = sections;
    if (section === void 0) throw new LookupError("not_found", `No section ${quote(ref.section)} in item ${quote(item.title)}`);
    if (sections.length > 1) {
      throw new LookupError(
        "ambiguous",
        `Section ${quote(ref.section)} matches ${sections.length} sections of item ${quote(item.title)} (ids ${ids(sections)}); use a section id`
      );
    }
    candidates = item.fields.filter((f) => f.sectionId === section.id);
    where = `section ${quote(ref.section)} of item ${quote(item.title)}`;
  }
  const found = matches(candidates, ref.field);
  const [field] = found;
  if (field === void 0) {
    if (ref.section === void 0 && NOTES_SEGMENTS.has(ref.field.toLowerCase())) return null;
    throw new LookupError("not_found", `No field ${quote(ref.field)} in ${where}`);
  }
  if (found.length > 1) {
    throw new LookupError(
      "ambiguous",
      `Field ${quote(ref.field)} matches ${found.length} fields of ${where} (ids ${ids(found)}); use a field id or name its section`
    );
  }
  return field;
}
function record(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v) ? v : void 0;
}
function detailsContent(field, type) {
  const details = record(field.details);
  return details?.["type"] === type ? record(details["content"]) : void 0;
}
function fieldValue(item, field, attribute2) {
  const what = `Field ${quote(field.title)} of item ${quote(item.title)}`;
  switch (attribute2) {
    case void 0:
      return field.value;
    case "otp": {
      const content = detailsContent(field, "Otp");
      const code = content?.["code"];
      if (typeof code === "string" && code !== "") return code;
      throw new LookupError("not_found", `${what} has no one-time code`);
    }
    case "public-key":
    case "fingerprint": {
      const content = detailsContent(field, "SshKey");
      const value = content?.[attribute2 === "public-key" ? "publicKey" : "fingerprint"];
      if (typeof value === "string" && value !== "") return value;
      throw new LookupError("not_found", `${what} has no SSH key ${attribute2}`);
    }
    case "private-key":
      if (field.fieldType === "SshKey") return field.value;
      throw new LookupError("not_found", `${what} is not an SSH key`);
  }
}
function sectionTitle(item, sectionId) {
  if (sectionId === void 0) return void 0;
  const title = item.sections.find((s) => s.id === sectionId)?.title;
  return title === void 0 || title === "" ? void 0 : title;
}
function namedAttribute(attribute2) {
  return attribute2 === "private-key" ? void 0 : attribute2;
}
async function resolveField(client, ref) {
  const vault = await findVault(client, ref.vault);
  const item = await findItem(client, vault, ref.item);
  const field = findField(item, ref);
  const attribute2 = namedAttribute(ref.attribute);
  const value = field === null ? item.notes : fieldValue(item, field, ref.attribute);
  const target = {
    vaultId: vault.id,
    vaultTitle: vault.title,
    itemId: item.id,
    itemTitle: item.title,
    category: item.category,
    fieldId: field === null ? NOTES_ID : field.id,
    fieldTitle: field === null ? NOTES_ID : field.title,
    sectionId: field?.sectionId,
    sectionTitle: field === null ? void 0 : sectionTitle(item, field.sectionId),
    fieldType: field === null ? NOTES_TYPE : field.fieldType,
    attribute: attribute2,
    notes: field === null
  };
  return { target, value };
}
async function itemGone(client, target) {
  try {
    const items = await client.listItems(target.vaultId);
    return !items.some((item) => item.id === target.itemId);
  } catch {
    try {
      const vaults = await client.listVaults();
      return !vaults.some((vault) => vault.id === target.vaultId);
    } catch {
      return false;
    }
  }
}
async function fetchValue(client, target) {
  let item;
  try {
    item = await client.getItem(target.vaultId, target.itemId);
  } catch (err) {
    if (await itemGone(client, target)) {
      throw new LookupError(
        "not_found",
        `Item ${quote(target.itemTitle)} is no longer in vault ${quote(target.vaultTitle)}`
      );
    }
    throw err;
  }
  if (target.notes) return item.notes;
  const field = item.fields.find((f) => f.id === target.fieldId);
  if (field === void 0) {
    throw new LookupError("not_found", `Field ${quote(target.fieldTitle)} is no longer in item ${quote(item.title)}`);
  }
  return fieldValue(item, field, target.attribute);
}
async function describeItem(client, ref) {
  const vault = await findVault(client, ref.vault);
  const item = await findItem(client, vault, ref.item);
  const fields = item.fields.map((f) => {
    const meta = {
      id: f.id,
      title: f.title,
      type: f.fieldType,
      masked: classify({ fieldType: f.fieldType, value: f.value }).masked
    };
    if (f.sectionId !== void 0) meta.sectionId = f.sectionId;
    const section = sectionTitle(item, f.sectionId);
    if (section !== void 0) meta.section = section;
    return meta;
  });
  if (item.notes !== "" && matches(item.fields, NOTES_ID).length === 0) {
    fields.push({
      id: NOTES_ID,
      title: NOTES_ID,
      type: NOTES_TYPE,
      masked: classify({ notes: true, value: item.notes }).masked
    });
  }
  return { vault: vault.title, item: { title: item.title, category: item.category }, fields };
}

// src/mask/masker.ts
function buildMasker(entries) {
  const byNeedle = /* @__PURE__ */ new Map();
  for (const e of entries) for (const n of e.needles) if (!byNeedle.has(n)) byNeedle.set(n, e.replacement);
  if (byNeedle.size === 0) return null;
  const alternatives = [...byNeedle.keys()].sort((a, b) => b.length - a.length).map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const re = new RegExp(alternatives.join("|"), "g");
  return (s) => s.replace(re, (m) => byNeedle.get(m) ?? "<masked>");
}
function isPlainObject(v) {
  if (v === null || typeof v !== "object") return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}
function maskDeep(v, mask) {
  if (typeof v === "string") {
    const masked = mask(v);
    return { changed: masked !== v, value: masked };
  }
  if (Array.isArray(v)) {
    let changed = false;
    const items = v.map((item) => {
      const result = maskDeep(item, mask);
      changed ||= result.changed;
      return result.value;
    });
    return changed ? { changed, value: items } : { changed, value: v };
  }
  if (isPlainObject(v)) {
    let changed = false;
    const entries = Object.entries(v).map(([key, item]) => {
      const result = maskDeep(item, mask);
      changed ||= result.changed;
      return [key, result.value];
    });
    return changed ? { changed, value: Object.fromEntries(entries) } : { changed, value: v };
  }
  return { changed: false, value: v };
}

// src/mask/needles.ts
var PEM_ARMOR = /^-----(BEGIN|END) [A-Z0-9 ]+-----$/;
var BASE64_WRAP = 76;
function needlesFor(value) {
  const out = /* @__PURE__ */ new Set();
  const add = (s) => {
    if (s.length >= MIN_MASK_LENGTH) out.add(s);
  };
  if (value.length < MIN_MASK_LENGTH) return [];
  add(value);
  add(JSON.stringify(value).slice(1, -1));
  const url = encodeURIComponent(value);
  add(url);
  add(url.replace(/%20/g, "+"));
  for (const raw of [value, `${value}
`]) {
    const b64 = Buffer.from(raw, "utf8").toString("base64");
    add(b64);
    add(b64.replace(/=+$/, ""));
    add(Buffer.from(raw, "utf8").toString("base64url"));
    if (b64.length > BASE64_WRAP) add(b64.replace(/(.{76})/g, "$1\n").replace(/\n$/, ""));
  }
  if (value.includes("\n")) {
    for (const line of value.split("\n")) {
      const t = line.replace(/\r$/, "").trim();
      if (!PEM_ARMOR.test(t)) add(t);
    }
  }
  return [...out];
}

// src/broker/masks.ts
function createMaskBook() {
  const sessions = /* @__PURE__ */ new Map();
  const maskers = /* @__PURE__ */ new Map();
  function masker(session, values) {
    let mask = maskers.get(session);
    if (mask === void 0) {
      mask = buildMasker(
        [...values].map(([value, holders]) => ({ replacement: `<masked ticket=${holders[0]?.ticket ?? "unknown"}>`, needles: needlesFor(value) }))
      );
      maskers.set(session, mask);
    }
    return mask;
  }
  return {
    arm(session, ticket, issuedAt, value) {
      let values = sessions.get(session);
      if (values === void 0) {
        values = /* @__PURE__ */ new Map();
        sessions.set(session, values);
      }
      const holders = values.get(value) ?? [];
      if (!holders.some((h) => h.ticket === ticket)) holders.push({ ticket, issuedAt });
      holders.sort((a, b) => a.issuedAt - b.issuedAt);
      values.set(value, holders);
      maskers.delete(session);
    },
    drop(session, tickets) {
      const dropping = new Set(tickets);
      const dropped = new Map([...dropping].map((t) => [t, "none"]));
      const values = sessions.get(session);
      if (values === void 0) return dropped;
      for (const [value, holders] of values) {
        const left = holders.filter((h) => !dropping.has(h.ticket));
        if (left.length === holders.length) continue;
        for (const h of holders) {
          if (!dropping.has(h.ticket)) continue;
          if (left.length === 0) dropped.set(h.ticket, "unmasked");
          else if (dropped.get(h.ticket) === "none") dropped.set(h.ticket, "kept");
        }
        if (left.length === 0) values.delete(value);
        else values.set(value, left);
      }
      if (values.size === 0) sessions.delete(session);
      maskers.delete(session);
      return dropped;
    },
    holds(session, ticket) {
      const values = sessions.get(session);
      if (values === void 0) return false;
      for (const holders of values.values()) if (holders.some((h) => h.ticket === ticket)) return true;
      return false;
    },
    apply(session, output) {
      const values = sessions.get(session);
      if (values === void 0) return { known: false, changed: false, output };
      const mask = masker(session, values);
      if (mask === null) return { known: true, changed: false, output };
      const { changed, value } = maskDeep(output, mask);
      return { known: true, changed, output: value };
    },
    forget(session) {
      sessions.delete(session);
      maskers.delete(session);
    },
    any: () => sessions.size > 0
  };
}

// src/broker/pool.ts
var OPERATION_TIMEOUT_MS = 12e4;
var KEEP_ALIVE_INTERVAL_MS = 24e4;
var KEEP_ALIVE_WINDOW_MS = 8 * 6e4;
var MAX_MESSAGE_LENGTH = 300;
var systemClock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle),
  setInterval: (fn, ms) => setInterval(fn, ms).unref(),
  clearInterval: (handle) => clearInterval(handle)
};
var PoolError = class extends Error {
  name = "PoolError";
  code;
  constructor(code, message) {
    super(message);
    this.code = code;
  }
};
function mapError(err) {
  if (err instanceof PoolError || err instanceof LookupError) return { code: err.code, message: err.message };
  const message = err instanceof Error ? err.message : String(err);
  if (message.includes("IPC operation failed: -3")) {
    return { code: "integration_off", message: `The 1Password app refuses SDK connections. Turn on 1Password > ${SDK_INTEGRATION_SETTING}.` };
  }
  if (/denied authorization/i.test(message)) {
    return { code: "auth_denied", message: "The 1Password authorization was denied." };
  }
  if (message.includes("desktop application not found") || message.includes("Native library is not available")) {
    return { code: "no_app", message: "The 1Password desktop app was not found." };
  }
  const short = message.length > MAX_MESSAGE_LENGTH ? `${message.slice(0, MAX_MESSAGE_LENGTH)}…` : message;
  return { code: "internal", message: `The 1Password call failed: ${short}` };
}
function createPool(options) {
  const clock = options.clock ?? systemClock;
  const timeoutMs = options.operationTimeoutMs ?? OPERATION_TIMEOUT_MS;
  const windowMs = options.keepAliveWindowMs ?? KEEP_ALIVE_WINDOW_MS;
  const clients = /* @__PURE__ */ new Map();
  const queue = [];
  const pinging = /* @__PURE__ */ new Set();
  let running = false;
  let refusal;
  const fresh = (entry) => entry?.lastOk !== void 0 && clock.now() - entry.lastOk < windowMs;
  const owns = () => {
    try {
      return options.owns();
    } catch {
      return false;
    }
  };
  function enqueue(account, fn, ping) {
    if (refusal !== void 0) return Promise.reject(new PoolError(refusal.code, refusal.message));
    return new Promise((resolve2, reject) => {
      queue.push({ account, fn, resolve: resolve2, reject, ping });
      pump();
    });
  }
  function pump() {
    while (!running && refusal === void 0) {
      const job = queue.shift();
      if (job === void 0) return;
      if (job.ping) {
        pinging.delete(job.account);
        if (!fresh(clients.get(job.account))) {
          job.resolve(void 0);
          continue;
        }
      }
      if (!owns()) {
        job.reject(new PoolError("displaced", "Another broker took over the socket"));
        continue;
      }
      start(job);
    }
  }
  function start(job) {
    running = true;
    let done = false;
    const timer = clock.setTimeout(() => {
      if (done) return;
      done = true;
      refusal = new PoolError("auth_timeout", `1Password did not answer within ${Math.round(timeoutMs / 1e3)} s`);
      job.reject(refusal);
      options.onStuck();
    }, timeoutMs);
    const finish = (settle) => {
      if (done) return;
      done = true;
      clock.clearTimeout(timer);
      running = false;
      settle();
      pump();
    };
    (async () => {
      let entry = clients.get(job.account);
      if (entry === void 0) {
        entry = { client: await options.connect(job.account), lastOk: void 0 };
        clients.set(job.account, entry);
      }
      return { entry, value: await job.fn(entry.client) };
    })().then(
      ({ entry, value }) => finish(() => {
        entry.lastOk = clock.now();
        job.resolve(value);
      }),
      (err) => finish(() => {
        const entry = clients.get(job.account);
        if (err instanceof LookupError && entry !== void 0) entry.lastOk = clock.now();
        else clients.delete(job.account);
        const failure = mapError(err);
        job.reject(new PoolError(failure.code, failure.message));
      })
    );
  }
  function tick() {
    if (refusal !== void 0) return;
    for (const [account, entry] of clients) {
      if (!fresh(entry) || pinging.has(account)) continue;
      pinging.add(account);
      enqueue(account, (client) => client.listVaults(), true).catch(() => {
      });
    }
  }
  const interval = clock.setInterval(tick, options.keepAliveIntervalMs ?? KEEP_ALIVE_INTERVAL_MS);
  function abort(code, message) {
    refusal ??= new PoolError(code, message);
    for (const job of queue.splice(0)) job.reject(new PoolError(code, message));
    pinging.clear();
  }
  return {
    run: (account, fn) => enqueue(account, fn, false),
    tick,
    accounts: () => [...clients].map(([account, entry]) => ({ account, warm: fresh(entry) })),
    abort,
    busy: () => running || queue.length > 0,
    drop() {
      clients.clear();
      pinging.clear();
    },
    close() {
      abort("internal", "The broker is shutting down");
      clock.clearInterval(interval);
      clients.clear();
    }
  };
}

// src/broker/tickets.ts
import { randomBytes } from "node:crypto";
var BASE32 = "abcdefghijklmnopqrstuvwxyz234567";
function newTicketId(random = randomBytes) {
  let id = "tkt_";
  for (const byte of random(16)) id += BASE32.charAt(byte & 31);
  return id;
}
var FINAL = /* @__PURE__ */ new Set(["used", "burned", "expired", "voided"]);
function unref(handle) {
  if (typeof handle === "object" && handle !== null && "unref" in handle && typeof handle.unref === "function") handle.unref();
  return handle;
}
function createTicketBook(clock, newId = newTicketId) {
  const tickets = /* @__PURE__ */ new Map();
  const timers = /* @__PURE__ */ new Map();
  const interrupts = /* @__PURE__ */ new Map();
  function settle(t, state) {
    t.state = state;
    if (state !== "waiting") interrupts.delete(t.id);
    if (FINAL.has(state)) {
      clock.clearTimeout(timers.get(t.id));
      timers.delete(t.id);
    }
  }
  function interrupt(t, why) {
    const notify = interrupts.get(t.id);
    settle(t, why);
    notify?.(why);
  }
  function held(t) {
    return tickets.get(t.id) === t;
  }
  function expire(t) {
    if (held(t) && (t.state === "unused" || t.state === "waiting")) interrupt(t, "expired");
  }
  function arm(t, ms) {
    clock.clearTimeout(timers.get(t.id));
    timers.set(t.id, unref(clock.setTimeout(() => expire(t), ms)));
  }
  function move(t, from, to) {
    if (!held(t) || !from.includes(t.state)) return false;
    settle(t, to);
    return true;
  }
  function answered(t, to) {
    if (held(t) && t.state === "waiting" && clock.now() >= t.expiresAt) {
      interrupt(t, "expired");
      return false;
    }
    return move(t, ["waiting"], to);
  }
  return {
    issue(spec, count) {
      const issuedAt = clock.now();
      const out = [];
      for (let i = 0; i < count; i++) {
        let id = newId();
        while (tickets.has(id)) id = newId();
        const t = { ...spec, id, issuedAt, expiresAt: issuedAt + TICKET_TTL_MS, state: "unused", released: false };
        tickets.set(id, t);
        arm(t, TICKET_TTL_MS);
        out.push(t);
      }
      return out;
    },
    find: (id) => tickets.get(id),
    refusal(t) {
      if (!held(t)) return "unknown";
      if (t.state === "unused" && clock.now() >= t.expiresAt) settle(t, "expired");
      switch (t.state) {
        case "unused":
          return void 0;
        case "waiting":
        case "sending":
        case "received":
          return "busy";
        case "used":
        case "burned":
          return "used";
        case "expired":
          return "expired";
        case "voided":
          return "voided";
      }
    },
    wait(t, onInterrupt) {
      if (!move(t, ["unused"], "waiting")) return false;
      interrupts.set(t.id, onInterrupt);
      return true;
    },
    deny: (t) => answered(t, "burned"),
    approve: (t) => answered(t, "sending"),
    receive: (t) => move(t, ["sending"], "received"),
    deliver: (t) => move(t, ["received"], "used"),
    giveBack(t) {
      if (!held(t)) return false;
      if (t.state !== "waiting" && t.state !== "sending" && t.state !== "received") return false;
      if (t.released) {
        settle(t, "voided");
        return true;
      }
      const left = t.expiresAt - clock.now();
      if (left <= 0) {
        settle(t, "expired");
        return true;
      }
      settle(t, "unused");
      arm(t, left);
      return true;
    },
    voidTicket(t) {
      if (!held(t) || FINAL.has(t.state)) return false;
      interrupt(t, "voided");
      return true;
    },
    release(t) {
      if (!held(t)) return "not_voided";
      if (t.state === "sending" || t.state === "received") {
        t.released = true;
        return "in_flight";
      }
      if (t.state !== "unused" && t.state !== "waiting") return "not_voided";
      interrupt(t, "voided");
      return "voided";
    },
    forget(session) {
      for (const t of [...tickets.values()]) {
        if (t.session !== session) continue;
        if (t.state === "waiting") interrupt(t, "voided");
        clock.clearTimeout(timers.get(t.id));
        timers.delete(t.id);
        interrupts.delete(t.id);
        tickets.delete(t.id);
      }
    },
    live: () => [...tickets.values()].some((t) => !FINAL.has(t.state))
  };
}

// src/broker/service.ts
var WATCH_INTERVAL_MS = 2e3;
var PROBE_TIMEOUT_MS = 1e3;
var STUCK_EXIT_MS = 1e3;
var REQUEST_READ_TIMEOUT_MS = 3e4;
var LISTEN_ATTEMPTS = 3;
function fail(code, message) {
  return { ok: false, code, message };
}
function errno(err) {
  return err !== null && typeof err === "object" ? err.code : void 0;
}
function probe(path, timeoutMs) {
  return new Promise((resolve2) => {
    let done = false;
    const socket = connect(path);
    const finish = (answered) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      socket.destroy();
      resolve2(answered);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    socket.on("error", () => finish(false));
    socket.once("connect", () => {
      socket.write(encodeLine({ v: PROTOCOL_VERSION, op: "status" }));
      readLine(socket).then(
        (line) => finish(line !== null && parseResponse(line, "status") !== null),
        () => finish(false)
      );
    });
  });
}
function prepareRunDir(dir) {
  mkdirSync2(dir, { recursive: true, mode: 448 });
  const st = lstatSync(dir);
  const uid = process.getuid?.();
  if (!st.isDirectory() || uid !== void 0 && st.uid !== uid) {
    throw new Error(`The socket directory ${dir} is not a directory owned by this user`);
  }
  chmodSync(dir, 448);
}
function listen(server, path) {
  return new Promise((resolve2, reject) => {
    const onError = (err) => {
      server.off("listening", onListening);
      reject(err);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve2();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(path);
  });
}
var DEFAULT_IDLE_MINUTES = 60;
var MAX_BROKER_LOG_BYTES = 1024 * 1024;
function idleWindowMs(value) {
  const minutes = value === void 0 || value.trim() === "" ? Number.NaN : Number(value);
  return (Number.isFinite(minutes) && minutes > 0 ? minutes : DEFAULT_IDLE_MINUTES) * 6e4;
}
function brokerLogPath(stateDir2) {
  return join4(stateDir2, "log", "broker.log");
}
function openBrokerLog(stateDir2) {
  const path = brokerLogPath(stateDir2);
  try {
    mkdirSync2(dirname2(path), { recursive: true, mode: 448 });
    if (statSync2(path).size > MAX_BROKER_LOG_BYTES) truncateSync(path, 0);
  } catch {
  }
  return (event, detail) => {
    try {
      appendFileSync(path, `${JSON.stringify({ at: (/* @__PURE__ */ new Date()).toISOString(), event, ...detail })}
`, { mode: 384 });
      chmodSync(path, 384);
    } catch {
    }
  };
}
function displayType(target) {
  return target.attribute === void 0 ? target.fieldType : `${target.fieldType} (${target.attribute})`;
}
var REFUSALS = {
  unknown: "No such ticket (never issued, or the broker restarted); call issue_tickets for a new one",
  not_owner: "Another session or another agent holds this ticket; a subagent issues its own tickets",
  busy: "The ticket is already waiting for an answer, or its value is being sent",
  used: "The ticket was already used or denied; call issue_tickets for a new one",
  voided: "The ticket was released or voided; call issue_tickets for a new one",
  expired: "The ticket expired after 10 minutes; call issue_tickets for a new one",
  other_agent: "Another agent of this session kept running commands for 30 s; retry when it is done",
  no_command: "No command of the ticket's agent is running; redeem inside the command that needs the value"
};
function refused2(code) {
  return fail(code, REFUSALS[code] ?? code);
}
async function startBroker(options) {
  const path = options.socketPath;
  const probeMs = options.probeTimeoutMs ?? PROBE_TIMEOUT_MS;
  const log2 = (event, detail) => {
    try {
      options.log(event, detail);
    } catch {
    }
  };
  prepareRunDir(dirname2(path));
  const alreadyServed = () => {
    log2("start", { result: "already-served" });
    options.exit(0);
    return null;
  };
  if (await probe(path, probeMs)) return alreadyServed();
  let refusal;
  let active = 0;
  let exiting = false;
  let lastActivity = Date.now();
  let idleTimer;
  let watch;
  let sweep;
  const server = createServer((socket) => void serve(socket));
  for (let attempt = 1; ; attempt++) {
    try {
      await listen(server, path);
      break;
    } catch (err) {
      if (errno(err) !== "EADDRINUSE" || attempt >= LISTEN_ATTEMPTS) throw err;
      if (await probe(path, probeMs)) return alreadyServed();
      try {
        unlinkSync(path);
      } catch (unlinkErr) {
        if (errno(unlinkErr) !== "ENOENT") throw unlinkErr;
      }
    }
  }
  chmodSync(path, 384);
  const bound = statSync2(path);
  const owns = () => {
    try {
      const now = statSync2(path);
      return now.ino === bound.ino && now.dev === bound.dev;
    } catch {
      return false;
    }
  };
  const pool = createPool({
    connect: options.connect,
    owns,
    onStuck,
    ...options.clock === void 0 ? {} : { clock: options.clock },
    ...options.operationTimeoutMs === void 0 ? {} : { operationTimeoutMs: options.operationTimeoutMs }
  });
  const clock = options.clock ?? systemClock;
  const book = createTicketBook(clock);
  const masks = createMaskBook();
  const seen = /* @__PURE__ */ new Map();
  function noteSession(id) {
    seen.set(id, clock.now());
  }
  function finish(reason, code, closeServer) {
    if (exiting) return;
    exiting = true;
    clearInterval(watch);
    clock.clearInterval(sweep);
    clearTimeout(idleTimer);
    options.dialog.close();
    pool.close();
    if (closeServer && owns()) server.close();
    log2("exit", { reason, code });
    options.exit(code);
  }
  function displaced() {
    if (refusal !== void 0 || exiting) return;
    refusal = fail("displaced", "Another broker took over the socket");
    log2("displaced");
    options.dialog.close();
    pool.abort("displaced", refusal.message);
    if (active === 0) finish("displaced", 0, false);
  }
  function onStuck() {
    if (exiting) return;
    refusal ??= fail("auth_timeout", "1Password did not answer in time; the next request starts a new broker");
    log2("stuck");
    options.dialog.close();
    pool.abort(refusal.code, refusal.message);
    clearInterval(watch);
    clock.clearInterval(sweep);
    clearTimeout(idleTimer);
    if (owns()) server.close();
    setTimeout(() => finish("stuck", 1, false), options.stuckExitMs ?? STUCK_EXIT_MS);
  }
  const forgetMs = options.sessionForgetMs ?? SESSION_FORGET_MS;
  function forgetQuiet() {
    const now = clock.now();
    for (const [id, at] of seen) {
      if (now - at <= forgetMs) continue;
      book.forget(id);
      masks.forget(id);
      seen.delete(id);
    }
  }
  function armIdle() {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      if (exiting || refusal !== void 0) return;
      if (pool.busy()) {
        armIdle();
        return;
      }
      pool.drop();
      if (active > 0 || book.live() || masks.any()) armIdle();
      else finish("idle", 0, true);
    }, options.idleMs);
    idleTimer.unref();
  }
  function touch() {
    lastActivity = Date.now();
    armIdle();
  }
  async function fields(req) {
    const ref = parseItemRef(req.ref);
    const described = await pool.run(req.account, (client) => describeItem(client, ref));
    return { ok: true, op: "fields", ...described };
  }
  async function issueTickets(req) {
    noteSession(req.session.id);
    const ref = parseFieldRef(req.ref);
    const { target, value } = await pool.run(req.account, (client) => resolveField(client, ref));
    const kind = classify({ fieldType: target.fieldType, attribute: ref.attribute, notes: target.notes, value });
    const issued = book.issue(
      {
        session: req.session.id,
        agent: req.agent,
        account: req.account,
        accountLabel: req.accountLabel,
        target,
        attribute: ref.attribute,
        kind,
        reason: req.reason,
        title: req.session.title
      },
      req.count
    );
    const first = issued[0];
    if (first === void 0) return fail("internal", "No ticket was issued");
    return {
      ok: true,
      op: "issue_tickets",
      tickets: issued.map((t) => t.id),
      expiresAt: new Date(first.expiresAt).toISOString(),
      field: { vault: target.vaultTitle, item: target.itemTitle, field: target.fieldTitle, type: displayType(target), masked: kind.masked, short: kind.short }
    };
  }
  function release(req) {
    noteSession(req.session);
    const results = [];
    const found = [...new Set(req.tickets)].map((id) => ({ id, t: book.find(id) }));
    const unmark = found.filter(({ t }) => t === void 0 || t.session === req.session).map(({ id }) => id);
    const dropped = masks.drop(req.session, unmark);
    for (const { id, t } of found) {
      if (t !== void 0 && t.session !== req.session) {
        results.push({ ticket: id, result: "not_owner" });
        continue;
      }
      const drop = dropped.get(id) ?? "none";
      const maskResult = drop === "none" ? void 0 : drop === "kept" ? "mask_kept" : "unmasked";
      if (t === void 0) {
        results.push({ ticket: id, result: maskResult ?? "unknown" });
        continue;
      }
      const released = book.release(t);
      if (released === "not_voided") results.push({ ticket: id, result: maskResult ?? "final" });
      else results.push({ ticket: id, result: released });
    }
    try {
      unmarkTickets(options.stateDir, req.session, unmark);
    } catch {
      log2("marker", { result: "unmark-failed" });
    }
    return { ok: true, op: "release", results };
  }
  function mask(req) {
    noteSession(req.session);
    const missing = [...new Set(req.tickets)].filter((id) => !masks.holds(req.session, id));
    if (missing.length > 0) return { ok: true, op: "mask", known: false, changed: false, output: null, missing };
    try {
      const { known, changed, output } = masks.apply(req.session, req.output);
      return { ok: true, op: "mask", known, changed, output: changed ? output : null, missing: [] };
    } catch {
      log2("mask", { result: "internal" });
      return fail("internal", "The broker could not apply the masks");
    }
  }
  function endSession(req) {
    book.forget(req.session);
    masks.forget(req.session);
    seen.delete(req.session);
    return { ok: true, op: "end_session" };
  }
  function brokerRefusal() {
    return refusal;
  }
  async function redeem(req, socket, lines) {
    const answer = (res) => {
      socket.end(encodeLine(res));
      return res.ok ? "ok" : res.code;
    };
    noteSession(req.session);
    const ticket = book.find(req.ticket);
    if (ticket === void 0) return answer(refused2("unknown"));
    if (ticket.session !== req.session) return answer(refused2("not_owner"));
    const early = book.refusal(ticket);
    if (early !== void 0) return answer(refused2(early));
    const closed = new AbortController();
    socket.once("close", () => closed.abort());
    if (socket.destroyed) closed.abort();
    const verdict = await attributeWaiting(
      () => readBoard(options.stateDir, ticket.session, Date.now()),
      ticket.agent.id,
      ticket.id,
      clock,
      closed.signal,
      options.attributionWaitMs ?? ATTRIBUTION_WAIT_MS,
      options.recheckMs ?? RECHECK_MS
    );
    if (verdict === null) return "closed";
    const forgotten = () => book.find(ticket.id) !== ticket;
    if (forgotten()) return answer(refused2("unknown"));
    const late = book.refusal(ticket);
    if (late !== void 0) return answer(refused2(late));
    const stoppedEarly = brokerRefusal();
    if (stoppedEarly !== void 0) return answer({ ...stoppedEarly });
    if (verdict.kind !== "attributed") return answer(refused2(verdict.code));
    const moved = () => answer(refused2(forgotten() ? "unknown" : book.refusal(ticket) ?? "busy"));
    const releasedInFetch = () => fail("voided", "The ticket was released while its value was fetched; nothing was sent");
    const sessionEnded = () => fail("voided", "The session ended while the value was fetched; nothing was sent");
    const shown = new AbortController();
    let interrupted = void 0;
    const waiting = book.wait(ticket, (why) => {
      interrupted = why;
      shown.abort();
    });
    if (!waiting) return moved();
    try {
      const onClose = () => shown.abort();
      closed.signal.addEventListener("abort", onClose, { once: true });
      touch();
      let choice;
      try {
        choice = await options.dialog.ask(
          ticketApproval(
            {
              session: { id: ticket.session, title: ticket.title, startDir: readSessionInfo(options.stateDir, ticket.session).cwd },
              agent: ticket.agent,
              account: ticket.accountLabel,
              vault: ticket.target.vaultTitle,
              item: ticket.target.itemTitle,
              category: ticket.target.category,
              section: ticket.target.sectionTitle,
              field: ticket.target.fieldTitle,
              fieldType: displayType(ticket.target),
              kind: ticket.kind,
              ticket: ticket.id,
              reason: ticket.reason,
              commands: verdict.commands
            },
            options.lang
          ),
          shown.signal
        );
      } finally {
        closed.signal.removeEventListener("abort", onClose);
      }
      if (interrupted !== void 0) return answer(refused2(interrupted));
      if (closed.signal.aborted) {
        book.giveBack(ticket);
        return "closed";
      }
      const stopped = brokerRefusal();
      if (stopped !== void 0) {
        book.giveBack(ticket);
        return answer({ ...stopped });
      }
      if (choice === "deny") {
        if (!book.deny(ticket)) return moved();
        return answer(fail("denied", "The user denied the request; the ticket is burned"));
      }
      if (choice !== "approve") {
        book.giveBack(ticket);
        return answer(
          fail("no_dialog", "No approval window can be shown on this host (macOS needs osascript, Linux needs zenity)")
        );
      }
      if (!book.approve(ticket)) return moved();
      let value;
      try {
        value = await pool.run(ticket.account, (client) => fetchValue(client, ticket.target));
      } catch (err) {
        const failure = mapError(err);
        if (failure.code === "displaced") displaced();
        if (forgotten()) return answer(sessionEnded());
        if (ticket.released) {
          book.voidTicket(ticket);
          return answer(releasedInFetch());
        }
        if (failure.code === "not_found") {
          book.voidTicket(ticket);
          return answer(fail("field_gone", `${failure.message}; the ticket is voided`));
        }
        book.giveBack(ticket);
        return answer(fail(failure.code, failure.message));
      } finally {
        touch();
      }
      if (forgotten()) return answer(sessionEnded());
      if (ticket.released) {
        book.voidTicket(ticket);
        return answer(releasedInFetch());
      }
      const kind = classify({ fieldType: ticket.target.fieldType, attribute: ticket.attribute, notes: ticket.target.notes, value });
      if (kind.masked) {
        try {
          markTicket(options.stateDir, ticket.session, ticket.id);
        } catch {
          book.giveBack(ticket);
          log2("marker", { result: "mark-failed" });
          return answer(fail("internal", "The mask marker could not be written; nothing was sent"));
        }
        masks.arm(ticket.session, ticket.id, ticket.issuedAt, value);
      }
      if (closed.signal.aborted) {
        book.giveBack(ticket);
        return "closed";
      }
      socket.write(encodeLine({ ok: true, op: "redeem", value }));
      const received = parseAck(await lines.next().catch(() => null));
      if (received !== "received") {
        book.giveBack(ticket);
        socket.destroy();
        return "not_received";
      }
      if (!book.receive(ticket) && !forgotten()) {
        socket.destroy();
        return "not_applied";
      }
      const delivered = parseAck(await lines.next().catch(() => null));
      let result;
      if (forgotten()) {
        result = "session_ended";
      } else if (delivered !== "delivered") {
        book.giveBack(ticket);
        result = "not_delivered";
      } else {
        result = book.deliver(ticket) ? "ok" : "not_applied";
      }
      socket.end();
      return result;
    } catch (err) {
      book.giveBack(ticket);
      throw err;
    }
  }
  async function handle(req) {
    if (refusal !== void 0) return { ...refusal };
    switch (req.op) {
      case "status":
        return { ok: true, op: "status", accounts: pool.accounts(), exitsAt: new Date(lastActivity + options.idleMs).toISOString() };
      case "release":
        return release(req);
      case "mask":
        return mask(req);
      case "end_session":
        return endSession(req);
      case "redeem":
        return fail("internal", `${req.op} is not served here`);
      default:
        break;
    }
    touch();
    try {
      return req.op === "fields" ? await fields(req) : await issueTickets(req);
    } catch (err) {
      const failure = err instanceof RefError ? { code: "bad_ref", message: err.message } : mapError(err);
      if (failure.code === "displaced") displaced();
      return fail(failure.code, failure.message);
    } finally {
      touch();
    }
  }
  async function serve(socket) {
    socket.on("error", () => {
    });
    active += 1;
    try {
      socket.setTimeout(REQUEST_READ_TIMEOUT_MS, () => socket.destroy());
      const lines = lineReader(socket, MAX_OUTPUT_BYTES);
      let line;
      try {
        line = await lines.next();
      } catch {
        line = null;
      }
      socket.setTimeout(0);
      if (line === null) {
        socket.destroy();
        return;
      }
      const req = parseRequest(line);
      if (req?.op !== "mask" && Buffer.byteLength(line) > MAX_LINE_BYTES) {
        log2("request", { op: req?.op ?? "malformed", result: "too_long" });
        socket.destroy();
        return;
      }
      lines.limit(MAX_LINE_BYTES);
      if (req?.op === "redeem" && refusal === void 0) {
        let result;
        try {
          result = await redeem(req, socket, lines);
        } catch {
          if (!socket.destroyed && !socket.writableEnded) {
            socket.end(encodeLine(fail("internal", "The broker could not serve this redeem")));
          }
          result = "internal";
        }
        log2("request", { op: "redeem", result });
        return;
      }
      let response;
      try {
        response = req === null ? fail("internal", "Malformed request") : await handle(req);
      } catch {
        response = fail("internal", "The broker could not serve this request");
      }
      log2("request", { op: req?.op ?? "malformed", result: response.ok ? "ok" : response.code });
      socket.end(encodeLine(response));
    } finally {
      active -= 1;
      if (refusal?.code === "displaced" && active === 0) finish("displaced", 0, false);
    }
  }
  watch = setInterval(() => {
    if (!owns()) displaced();
  }, options.watchMs ?? WATCH_INTERVAL_MS);
  watch.unref();
  sweep = clock.setInterval(forgetQuiet, Math.min(forgetMs, FORGET_SCAN_MS));
  armIdle();
  log2("start", { result: "listening" });
  return { server, owns };
}

// src/broker/main.ts
function errorCode(err) {
  if (err !== null && typeof err === "object") {
    const code = err.code;
    if (typeof code === "string" && /^[A-Z][A-Z0-9_]{0,31}$/.test(code)) return code;
    const name = err.name;
    if (typeof name === "string" && /^[A-Za-z][A-Za-z0-9]{0,39}$/.test(name)) return name;
  }
  return "unknown";
}
var env = process.env;
var stateDir = resolveStateDir(env);
var log = openBrokerLog(stateDir);
var pluginRoot = fileURLToPath(new URL("..", import.meta.url));
startBroker({
  socketPath: socketPath(stateDir, process.getuid?.() ?? 0, tmpdir(), env["XDG_RUNTIME_DIR"]),
  stateDir,
  connect: (account) => connectDesktop(account),
  dialog: platformDialog(runCommand, process.platform, pluginRoot),
  lang: env["OP_BRIDGE_LANGUAGE"],
  idleMs: idleWindowMs(env["OP_BRIDGE_IDLE_MINUTES"]),
  exit: (code) => process.exit(code),
  log
}).catch((err) => {
  log("fatal", { code: errorCode(err) });
  process.exit(1);
});
