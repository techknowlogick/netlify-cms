import {
  localForage,
  parseLinkHeader,
  unsentRequest,
  then,
  APIError,
  Cursor,
  ApiRequest,
  Entry,
  AssetProxy,
  PersistOptions,
  readFile,
  CMS_BRANCH_PREFIX,
  generateContentKey,
  isCMSLabel,
  EditorialWorkflowError,
  labelToStatus,
  statusToLabel,
  DEFAULT_PR_BODY,
  MERGE_COMMIT_MESSAGE,
  responseParser,
  PreviewState,
  parseContentKey,
  branchFromContentKey,
  requestWithBackoff,
  readFileMetadata,
  FetchError,
} from 'netlify-cms-lib-util';
import { Base64 } from 'js-base64';
import { Map } from 'immutable';
import { flow, partial, result, trimStart } from 'lodash';

export const API_NAME = 'Gitea';

export interface Config {
  apiRoot?: string;
  token?: string;
  branch?: string;
  repo?: string;
  squashMerges: boolean;
  initialWorkflowStatus: string;
}

export interface CommitAuthor {
  name: string;
  email: string;
}

type GiteaPullRequest = {
  id: number;
  number: number; // ID of PR
  title: string;
  body: string; // description
  state: string;
  merged_by: {
    full_name: string;
    login: string; // username
    id: number;
  };
  merged_at: string;
  created_at: string;
  updated_at: string;
  target_branch: string;
  source_branch: string;
  user: {
    full_name: string;
    login: string;
    id: number;
  };
  labels: string[];
  head: {
    sha: string
  }
};

export default class API {
  apiRoot: string;
  token: string | boolean;
  branch: string;
  useOpenAuthoring?: boolean;
  repo: string;
  repoURL: string;
  commitAuthor?: CommitAuthor;
  squashMerges: boolean;
  initialWorkflowStatus: string;

  constructor(config: Config) {
    this.apiRoot = config.apiRoot || 'https://gitea.com/api/v1';
    this.token = config.token || false;
    this.branch = config.branch || 'master';
    this.repo = config.repo || '';
    this.repoURL = `/repos/${this.repo}`;
    this.squashMerges = config.squashMerges;
    this.initialWorkflowStatus = config.initialWorkflowStatus;
  }

  withAuthorizationHeaders = (req: ApiRequest) => {
    const withHeaders = unsentRequest.withHeaders(
      this.token ? { Authorization: `Bearer ${this.token}` } : {},
      req,
    );
    return Promise.resolve(withHeaders);
  };

  buildRequest = async (req: ApiRequest) => {
    const withRoot: ApiRequest = unsentRequest.withRoot(this.apiRoot)(req);
    const withAuthorizationHeaders = await this.withAuthorizationHeaders(withRoot);

    if (withAuthorizationHeaders.has('cache')) {
      return withAuthorizationHeaders;
    } else {
      const withNoCache: ApiRequest = unsentRequest.withNoCache(withAuthorizationHeaders);
      return withNoCache;
    }
  };

  request = (req: ApiRequest): Promise<Response> => {
    try {
      return requestWithBackoff(this, req);
    } catch (err) {
      throw new APIError(err.message, null, API_NAME);
    }
  };

  responseToJSON = responseParser({ format: 'json', apiName: API_NAME });
  responseToBlob = responseParser({ format: 'blob', apiName: API_NAME });
  responseToText = responseParser({ format: 'text', apiName: API_NAME });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  requestJSON = (req: ApiRequest) => this.request(req).then(this.responseToJSON) as Promise<any>;
  requestText = (req: ApiRequest) => this.request(req).then(this.responseToText) as Promise<string>;

  user = () => this.requestJSON('/user');

  hasWriteAccess = async () => {
    const response = await this.requestJSON(this.repoURL);
    if (response.status === 404) {
      throw Error('Repo not found');
    }
    return response.permissions.push ||response.permissions.admin;
  };

  branchCommitSha = async (branch: string) => {
    const branchInfo = await this.requestJSON(`${this.repoURL}/branches/${branch}`);
    const branchSha = branchInfo.commit.id
    return branchSha;
  };

  defaultBranchCommitSha = () => {
    return this.branchCommitSha(this.branch);
  };

  async readFileMetadata(path: string, sha: string | null | undefined) {
    // TODO: complete this function
    const fetchFileMetadata = async () => {
      try {
        const values = await this.requestJSON({
          url: `${this.repoURL}/contents/${path}`,
          params: { ref: this.branch },
        });
        const commit = values[0];
        return {
          author: commit.author.user
            ? commit.author.user.display_name || commit.author.user.nickname
            : commit.author.raw,
          updatedOn: commit.date,
        };
      } catch (e) {
        return { author: '', updatedOn: '' };
      }
    };
    const fileMetadata = await readFileMetadata(sha, fetchFileMetadata, localForage);
    return fileMetadata;
  }
  listFiles = async (path: string, depth = 1, pagelen = 200) => {
    const node = await this.branchCommitSha(this.branch);
    const result = await this.requestJSON({
      url: `${this.repoURL}/git/trees/${node}`,
      params: {
        // eslint-disable-next-line @typescript-eslint/camelcase
        page: depth,
        per_page: pagelen,
        recursive: true
      },
    });

    // TODO: Filter path

    //const { entries, cursor } = this.getEntriesAndCursor(result);

    return { entries: result.tree };
  };
}
