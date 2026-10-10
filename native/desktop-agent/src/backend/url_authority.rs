// -*- coding: utf-8 -*-
//! url_authority.rs
//! Private native browser origin authority
//! =====================
//! Select committed top-document metadata and browser-chrome fallback sources before privacy output.

use serde_json::Value;

use super::BackendError;

/// UrlPlatform selects the native role vocabulary of a private metadata reader.
#[derive(Clone, Copy)]
pub(super) enum UrlPlatform {
    #[cfg(any(target_os = "macos", test))]
    Mac,
    #[cfg(any(target_os = "linux", test))]
    Linux,
}

/// TrustedBrowserUrl binds the observed origin to its native window and document sources.
#[derive(Debug, PartialEq, Eq)]
pub(super) struct TrustedBrowserUrl {
    pub(super) window_id: String,
    pub(super) source_id: String,
    pub(super) document_id: Option<String>,
    pub(super) url: String,
}

/// Select one native window only after complete geometry matching excludes ambiguity.
///
/// Args:
///     matches (&[Option<bool>]): One entry per native window, with None for unreadable geometry.
/// Returns:
///     Result<usize, BackendError>: Unique matching window index or a closed identity gate.
pub(super) fn unique_window_index(matches: &[Option<bool>]) -> Result<usize, BackendError> {
    // An unreadable native window can conceal another match and prevents completeness proof.
    if matches.iter().any(Option::is_none) {
        return Err(BackendError::new(
            "UNSUPPORTED_CAPABILITY",
            "Native window geometry is incomplete",
            true,
        ));
    }
    let candidates: Vec<usize> = matches
        .iter()
        .enumerate()
        .filter_map(|(index, matching)| (*matching == Some(true)).then_some(index))
        .collect();
    // Duplicate rectangles require explicit native identity support rather than first-match selection.
    match candidates.as_slice() {
        [index] => Ok(*index),
        [] => Err(BackendError::new(
            "TARGET_NOT_FOUND",
            "Native window geometry has no match",
            true,
        )),
        _ => Err(BackendError::new(
            "TARGET_STALE",
            "Native window geometry is ambiguous",
            true,
        )),
    }
}

/// Require a complete unique geometry match to retain the exact bound native window identifier.
///
/// Args:
///     candidates (&[(String, Option<bool>)]): Native window identifiers and complete geometry results.
///     expected (&str): Independently bound operating-system window identifier.
/// Returns:
///     Result<usize, BackendError>: Matching bound window index or a closed identity gate.
pub(super) fn unique_bound_window_index(
    candidates: &[(String, Option<bool>)],
    expected: &str,
) -> Result<usize, BackendError> {
    let matches: Vec<Option<bool>> = candidates.iter().map(|(_, matching)| *matching).collect();
    let selected = unique_window_index(&matches)?;
    // A visible replacement window cannot inherit an absent bound window's authority through geometry.
    if candidates[selected].0 != expected {
        return Err(BackendError::new(
            "TARGET_STALE",
            "Native window geometry belongs to a different window",
            true,
        ));
    }
    Ok(selected)
}

/// Identify native document boundaries that exclude webpage authority candidates.
///
/// Args:
///     platform (UrlPlatform): Native metadata reader vocabulary.
///     role (&str): Original native accessibility role.
/// Returns:
///     bool: Whether authority traversal stops at this document boundary.
pub(super) fn document_boundary(platform: UrlPlatform, role: &str) -> bool {
    match platform {
        #[cfg(any(target_os = "macos", test))]
        UrlPlatform::Mac => matches!(role, "AXWebArea" | "AXDocument"),
        #[cfg(any(target_os = "linux", test))]
        UrlPlatform::Linux => matches!(role, "document web" | "document frame" | "document"),
    }
}

/// Identify the root document role that carries native committed browsing metadata.
///
/// Args:
///     platform (UrlPlatform): Native metadata reader vocabulary.
///     role (&str): Original native accessibility role.
/// Returns:
///     bool: Whether this role is a native root web document.
pub(super) fn root_document(platform: UrlPlatform, role: &str) -> bool {
    match platform {
        #[cfg(any(target_os = "macos", test))]
        UrlPlatform::Mac => role == "AXWebArea",
        #[cfg(any(target_os = "linux", test))]
        UrlPlatform::Linux => role == "document web",
    }
}

/// Identify the native browser toolbar role outside document content.
///
/// Args:
///     platform (UrlPlatform): Native metadata reader vocabulary.
///     role (&str): Original native accessibility role.
/// Returns:
///     bool: Whether this role establishes browser toolbar ancestry.
pub(super) fn chrome_toolbar(platform: UrlPlatform, role: &str) -> bool {
    match platform {
        #[cfg(any(target_os = "macos", test))]
        UrlPlatform::Mac => role == "AXToolbar",
        #[cfg(any(target_os = "linux", test))]
        UrlPlatform::Linux => matches!(role, "tool bar" | "toolbar"),
    }
}

/// Identify native text-field roles eligible for browser address fallback.
///
/// Args:
///     platform (UrlPlatform): Native metadata reader vocabulary.
///     role (&str): Original native accessibility role.
/// Returns:
///     bool: Whether the control can expose a native browser address value.
pub(super) fn address_role(platform: UrlPlatform, role: &str) -> bool {
    match platform {
        #[cfg(any(target_os = "macos", test))]
        UrlPlatform::Mac => matches!(role, "AXTextField" | "AXComboBox"),
        #[cfg(any(target_os = "linux", test))]
        UrlPlatform::Linux => matches!(role, "entry" | "text field" | "combo box" | "autocomplete"),
    }
}

/// Collect top-document and unfocused browser-toolbar candidates from private native records.
///
/// Args:
///     node (&Value): Private reader node with original native roles and identities.
///     platform (UrlPlatform): Original native role vocabulary.
///     toolbar (bool): Whether native browser toolbar ancestry is established.
///     documents (&mut Vec<&Value>): Top-document metadata records.
///     addresses (&mut Vec<&Value>): Qualified unedited browser address controls.
/// Returns:
///     (): Completion of document-boundary-aware candidate extraction.
fn url_candidates<'a>(
    node: &'a Value,
    platform: UrlPlatform,
    toolbar: bool,
    documents: &mut Vec<&'a Value>,
    addresses: &mut Vec<&'a Value>,
) {
    let role = node["role"].as_str().unwrap_or("");
    // Stop before webpage controls, ARIA toolbars, and iframe documents can become URL sources.
    if document_boundary(platform, role) {
        if root_document(platform, role) {
            documents.push(node);
        }
        return;
    }
    let toolbar = toolbar || chrome_toolbar(platform, role);
    // Require browser-chrome ancestry, an address marker, and an explicitly unfocused field.
    if toolbar
        && address_role(platform, role)
        && (node["identifier"] == "omnibox" || node["name"] == "Address and search bar")
        && node["focused"] == false
    {
        addresses.push(node);
    }
    // Inspect only descendants that remain outside document authority boundaries.
    if let Some(children) = node["children"].as_array() {
        for child in children {
            url_candidates(child, platform, toolbar, documents, addresses);
        }
    }
}

/// Select a committed native document URL or one qualified browser-chrome fallback source.
///
/// Args:
///     window (&Value): Private metadata of the independently bound native browser window.
///     platform (UrlPlatform): Native accessibility role vocabulary.
/// Returns:
///     Result<TrustedBrowserUrl, BackendError>: Qualified native origin and source identities.
pub(super) fn trusted_browser_url(
    window: &Value,
    platform: UrlPlatform,
) -> Result<TrustedBrowserUrl, BackendError> {
    let mut documents = Vec::new();
    let mut addresses = Vec::new();
    url_candidates(window, platform, false, &mut documents, &mut addresses);
    // Exposed multiple root documents require explicit active-document mapping before authority use.
    if documents.len() > 1 {
        return Err(BackendError::new(
            "UNSUPPORTED_CAPABILITY",
            "Native document identity is ambiguous",
            false,
        ));
    }
    let document = documents.first().copied();
    let source = if document.is_some_and(|node| node.get("documentUrl").is_some()) {
        document.unwrap()
    } else {
        // Use the fallback only when exactly one qualified browser address control is present.
        if addresses.len() != 1 {
            return Err(BackendError::new(
                "UNSUPPORTED_CAPABILITY",
                "Native browser URL is unavailable",
                false,
            ));
        }
        addresses[0]
    };
    let url = source
        .get("documentUrl")
        .or_else(|| source.get("value"))
        .and_then(Value::as_str)
        .unwrap_or("");
    // Preserve complete origin-bearing values and reject unsupported native schemes.
    if url.len() > 16384
        || !(url.starts_with("https://") || url.starts_with("http://") || url == "about:blank")
    {
        return Err(BackendError::new(
            "UNSUPPORTED_CAPABILITY",
            "Native browser URL is unverified",
            false,
        ));
    }
    let window_id = window["nativeId"].as_str().unwrap_or("");
    let source_id = source["nativeId"].as_str().unwrap_or("");
    let document_id = document
        .and_then(|value| value["nativeId"].as_str())
        .filter(|value| !value.is_empty())
        .map(str::to_owned);
    // Bind authority to native identities instead of visible page labels or public node ordinals.
    if window_id.is_empty() || source_id.is_empty() || (document.is_some() && document_id.is_none())
    {
        return Err(BackendError::new(
            "TARGET_STALE",
            "Native URL source identity is absent",
            true,
        ));
    }
    Ok(TrustedBrowserUrl {
        window_id: window_id.to_owned(),
        source_id: source_id.to_owned(),
        document_id,
        url: url.to_owned(),
    })
}

/// Require unchanged native source identities and committed URL around public observation.
///
/// Args:
///     before (&TrustedBrowserUrl): Origin identity read before the privacy tree.
///     after (&TrustedBrowserUrl): Origin identity read after the privacy tree.
/// Returns:
///     Result<(), BackendError>: Consistent native identity or a retryable stale observation.
pub(super) fn consistent_browser_url(
    before: &TrustedBrowserUrl,
    after: &TrustedBrowserUrl,
) -> Result<(), BackendError> {
    if before != after {
        return Err(BackendError::new(
            "TARGET_STALE",
            "Native browser origin or document changed",
            true,
        ));
    }
    Ok(())
}

/// Read geometry exclusively from the selected native root document identity.
///
/// Args:
///     window (&Value): Private native metadata of the bound browser window.
///     platform (UrlPlatform): Native accessibility role vocabulary.
///     source (&TrustedBrowserUrl): Selected native document and source identity.
/// Returns:
///     Option<&Value>: Verified root-document screen bounds when available.
pub(super) fn document_geometry<'a>(
    window: &'a Value,
    platform: UrlPlatform,
    source: &TrustedBrowserUrl,
) -> Option<&'a Value> {
    let mut documents = Vec::new();
    let mut addresses = Vec::new();
    url_candidates(window, platform, false, &mut documents, &mut addresses);
    documents
        .into_iter()
        .find(|node| node["nativeId"].as_str() == source.document_id.as_deref())?
        .get("bounds")
}

/// Classify original AX optional-attribute status without treating provider failure as a leaf.
///
/// Args:
///     status (i32): Original AXUIElementCopyAttributeValue result.
///     has_value (bool): Whether the native operation returned a nonnull value.
/// Returns:
///     Result<bool, BackendError>: True for a complete value, false for an explicit absent attribute.
#[cfg(any(target_os = "macos", test))]
pub(super) fn mac_optional_attribute_status(
    status: i32,
    has_value: bool,
) -> Result<bool, BackendError> {
    // Preserve the native distinction between unsupported attributes and incomplete provider calls.
    match (status, has_value) {
        (0, true) => Ok(true),
        (-25205 | -25212, false) => Ok(false),
        (-25211, _) => Err(BackendError::new(
            "PERMISSION_REQUIRED",
            "Native accessibility authorization is unavailable",
            true,
        )),
        (-25202, _) => Err(BackendError::new(
            "TARGET_STALE",
            "Native accessibility object is invalid",
            true,
        )),
        (-25204, _) => Err(BackendError::new(
            "TIMEOUT",
            "Native accessibility provider did not complete",
            true,
        )),
        _ => Err(BackendError::new(
            "INPUT_BACKEND_UNAVAILABLE",
            "Native metadata attribute is incomplete",
            true,
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// Verify matching rectangles from two same-process windows cannot select the first origin.
    ///
    /// Args:
    ///     None.
    /// Returns:
    ///     (): Successful mocked window ambiguity and completeness assertions.
    #[test]
    fn native_window_selection_requires_unique_complete_geometry() {
        assert_eq!(unique_window_index(&[Some(false), Some(true)]).unwrap(), 1);
        assert_eq!(
            unique_window_index(&[Some(true), Some(true)])
                .unwrap_err()
                .code,
            "TARGET_STALE"
        );
        assert!(unique_window_index(&[Some(true), None]).is_err());
        assert!(unique_window_index(&[]).is_err());
        let replacement = [("visible-other".to_owned(), Some(true))];
        assert_eq!(
            unique_bound_window_index(&replacement, "bound-hidden")
                .unwrap_err()
                .code,
            "TARGET_STALE"
        );
        assert_eq!(
            unique_bound_window_index(&replacement, "visible-other").unwrap(),
            0
        );
    }

    /// Verify provider failure prevents completion instead of hiding a potential document subtree.
    ///
    /// Args:
    ///     None.
    /// Returns:
    ///     (): Successful mocked original-status and malformed-output assertions.
    #[test]
    fn mac_metadata_children_failures_cannot_become_empty_leaves() {
        assert!(!mac_optional_attribute_status(-25205, false).unwrap());
        assert!(!mac_optional_attribute_status(-25212, false).unwrap());
        assert!(mac_optional_attribute_status(0, true).unwrap());
        // Incomplete provider reads and successful null results cannot complete a private tree.
        for (status, present) in [
            (-25204, false),
            (-25211, false),
            (-25202, false),
            (-25200, false),
            (0, false),
            (-25212, true),
        ] {
            assert!(mac_optional_attribute_status(status, present).is_err());
        }
    }

    /// Verify page-owned toolbar names and nested frames cannot replace committed native origin.
    ///
    /// Args:
    ///     None.
    /// Returns:
    ///     (): Successful synthetic private-metadata authority assertions for both platforms.
    #[test]
    fn page_controls_and_iframes_have_no_origin_authority() {
        for (platform, document, toolbar, field) in [
            (UrlPlatform::Mac, "AXWebArea", "AXToolbar", "AXTextField"),
            (UrlPlatform::Linux, "document web", "tool bar", "entry"),
        ] {
            let tree = json!({"nativeId":"window","role":"window","children":[{"nativeId":"doc","role":document,"documentUrl":"https://blocked.example/","children":[{"role":toolbar,"children":[{"nativeId":"fake","role":field,"name":"Address and search bar","identifier":"omnibox","focused":false,"value":"http://127.0.0.1:8080/"}]},{"nativeId":"iframe","role":document,"documentUrl":"http://localhost:8080/"}]}]});
            assert_eq!(
                trusted_browser_url(&tree, platform).unwrap().url,
                "https://blocked.example/"
            );
            let mut missing = tree.clone();
            missing["children"][0]
                .as_object_mut()
                .unwrap()
                .remove("documentUrl");
            assert_eq!(
                trusted_browser_url(&missing, platform).unwrap_err().code,
                "UNSUPPORTED_CAPABILITY"
            );
        }
    }

    /// Verify native toolbar fallback ignores focused values and absent chrome ancestry.
    ///
    /// Args:
    ///     None.
    /// Returns:
    ///     (): Successful synthetic committed-address and provenance boundary assertions.
    #[test]
    fn fallback_requires_unfocused_native_toolbar_ancestry() {
        for (platform, toolbar, field) in [
            (UrlPlatform::Mac, "AXToolbar", "AXTextField"),
            (UrlPlatform::Linux, "tool bar", "entry"),
        ] {
            let mut tree = json!({"nativeId":"window","role":"window","children":[{"role":toolbar,"children":[{"nativeId":"omnibox","role":field,"identifier":"omnibox","name":"Address and search bar","focused":false,"value":"https://committed.example/"}]}]});
            assert_eq!(
                trusted_browser_url(&tree, platform).unwrap().url,
                "https://committed.example/"
            );
            tree["children"][0]["children"][0]["focused"] = json!(true);
            assert!(trusted_browser_url(&tree, platform).is_err());
            tree["children"][0]["children"][0]["focused"] = json!(false);
            tree["children"][0]["role"] = json!("group");
            assert!(trusted_browser_url(&tree, platform).is_err());
        }
    }

    /// Verify public privacy pruning remains independent from committed native URL authority.
    ///
    /// Args:
    ///     None.
    /// Returns:
    ///     (): Successful synthetic sensitive-root and public snapshot rejection assertions.
    #[test]
    fn private_document_authority_survives_public_privacy_pruning() {
        for (platform, document) in [
            (UrlPlatform::Mac, "AXWebArea"),
            (UrlPlatform::Linux, "document web"),
        ] {
            let metadata = json!({"nativeId":"window","role":"window","name":"Card Password","states":["protected"],"children":[{"nativeId":"doc","role":document,"documentUrl":"https://blocked.example/","bounds":{"x":10,"y":20,"width":300,"height":200}}]});
            let public = json!({"nodeId":"public-1","role":"window","states":["protected"],"value":"http://localhost/"});
            let trusted = trusted_browser_url(&metadata, platform).unwrap();
            assert_eq!(trusted.url, "https://blocked.example/");
            assert_eq!(
                document_geometry(&metadata, platform, &trusted).unwrap()["x"],
                10
            );
            assert!(trusted_browser_url(&public, platform).is_err());
        }
    }

    /// Verify document replacement, ambiguity, and unsupported schemes retain a closed authority gate.
    ///
    /// Args:
    ///     None.
    /// Returns:
    ///     (): Successful synthetic navigation-race and metadata validity assertions.
    #[test]
    fn document_identity_changes_and_ambiguity_require_new_observation() {
        for (platform, document) in [
            (UrlPlatform::Mac, "AXWebArea"),
            (UrlPlatform::Linux, "document web"),
        ] {
            let mut metadata = json!({"nativeId":"window","role":"window","children":[{"nativeId":"doc-before","role":document,"documentUrl":"https://committed.example/"}]});
            let before = trusted_browser_url(&metadata, platform).unwrap();
            metadata["children"][0]["nativeId"] = json!("doc-after");
            let after = trusted_browser_url(&metadata, platform).unwrap();
            assert_eq!(
                consistent_browser_url(&before, &after).unwrap_err().code,
                "TARGET_STALE"
            );
            metadata["children"].as_array_mut().unwrap().push(
                json!({"nativeId":"second","role":document,"documentUrl":"http://localhost/"}),
            );
            assert!(trusted_browser_url(&metadata, platform).is_err());
            metadata["children"].as_array_mut().unwrap().pop();
            metadata["children"][0]["documentUrl"] = json!("file:///private");
            assert!(trusted_browser_url(&metadata, platform).is_err());
        }
    }
}
