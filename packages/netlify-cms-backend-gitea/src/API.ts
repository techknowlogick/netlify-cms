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
  loadedEntries
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
    console.log(`branchCommitSha: ${branch}`)
    const branchInfo = await this.requestJSON(`${this.repoURL}/branches/${branch}`);
    const branchSha = branchInfo.commit.id
    return branchSha;
  };

  defaultBranchCommitSha = () => {
    console.log("defaultBranchCommitSha")
    return this.branchCommitSha(this.branch);
  };

  listFiles = async (path: string, recursive = false) => {
    console.log(`listFiles: ${path} ${recursive}`)
    let listCall = {truncated:true, tree:[]},
        files = [],
        page = 1,
        per_page = 400;
    while (listCall.truncated == true ) {
      listCall = await this.requestJSON({
        url: `${this.repoURL}/git/trees/${await this.defaultBranchCommitSha()}`,
        params: {
          page,
          per_page,
          recursive: true
        }
      })
      page = page + 1
      files.push(...listCall.tree.filter(item=>{
        return (item.type == "blob")
      }).filter(item=>{
        return item.path.startsWith(path)
      }).filter(item=>{
        if (recursive) {
          // if recursive then allow all below specific subdir
          return true
        }
        // if no recurse, then look only at file in dir
        return (path.split("/").length) == (item.path.split("/")-1)
      }).map(file=>({
        type: file.type,
        id: file.sha,
        name: file.name,
        path: file.path,
        size: file.size
      })));
    }
    return files
  }; // Done

  readFile = async (
    path: string,
    sha: string,
    { parseText = true, branch = this.branch } = {},
  ): Promise<string | Blob> => {
    console.log(`readFile: ${path} ${sha}`)
    const fetchContent = async () => {
      const content = await this.request({
        url: `${this.repoURL}/contents/${path}`,
        params: { ref: branch },
      }).then<Blob | string>(this.responseToJSON)
      .then((data)=>{
        if(parseText) {
          return this.fromBase64(data.content)
        }
        return b64toBlob(data.content)
      });
      return content;
    };
    const content = await readFile(sha, fetchContent, localForage, parseText);
    return content;
  };

  toBase64 = (str: string) => Promise.resolve(Base64.encode(str));
  fromBase64 = (str: string) => Base64.decode(str);
}


// source: https://stackoverflow.com/questions/16245767/creating-a-blob-from-a-base64-string-in-javascript
const b64toBlob = (b64Data, contentType = '', sliceSize = 512) => {
  const byteCharacters = atob(b64Data);
  const byteArrays = [];

  for (let offset = 0; offset < byteCharacters.length; offset += sliceSize) {
    const slice = byteCharacters.slice(offset, offset + sliceSize);

    const byteNumbers = new Array(slice.length);
    for (let i = 0; i < slice.length; i++) {
      byteNumbers[i] = slice.charCodeAt(i);
    }

    const byteArray = new Uint8Array(byteNumbers);
    byteArrays.push(byteArray);
  }

  const blob = new Blob(byteArrays, { type: contentType });
  return blob;
}