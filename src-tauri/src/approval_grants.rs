pub use crate::models::{
    ApprovalGrant, ApprovalGrantScope, ApprovalGrantStatus, ApprovalGrantType,
};

pub fn grant_allows_path(grant: &ApprovalGrant, path: &str) -> bool {
    grant.status == ApprovalGrantStatus::Active
        && grant
            .scope
            .paths
            .iter()
            .any(|pattern| path_matches(pattern, path))
}

fn path_matches(pattern: &str, path: &str) -> bool {
    if let Some(prefix) = pattern.strip_suffix('*') {
        return path.starts_with(prefix);
    }
    if let Some((prefix, suffix)) = pattern.split_once('*') {
        return path.starts_with(prefix) && path.ends_with(suffix);
    }
    pattern == path
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn file_grant_allows_matching_path_pattern() {
        let grant = ApprovalGrant {
            id: "grant-1".into(),
            workflow_id: "workflow".into(),
            workflow_version: 1,
            capability_id: "local_app.write_artifact".into(),
            grant_type: ApprovalGrantType::FileOverwrite,
            scope: ApprovalGrantScope {
                credential_ref: None,
                paths: vec!["/tmp/raven/*.md".into()],
                domains: vec![],
                resource_ids: vec![],
                max_deletes: None,
                max_overwrite_bytes: Some(1024),
                external_targets: vec![],
            },
            approved_by_user_at: "2026-06-21T00:00:00Z".into(),
            expires_at: None,
            signature_hash: "hash".into(),
            status: ApprovalGrantStatus::Active,
        };

        assert!(grant_allows_path(&grant, "/tmp/raven/report.md"));
        assert!(!grant_allows_path(&grant, "/tmp/other/report.md"));
    }
}
