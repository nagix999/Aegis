import type { Deployment } from './aegis-types';

export function currentDeployments(deployments: Deployment[]): Deployment[] {
  return [...deployments].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt) || b.version - a.version).reduce<Deployment[]>((result, deployment) => {
    if (!result.some(item => item.alias === deployment.alias)) result.push(deployment);
    return result;
  }, []);
}

export function deployedCurl(baseUrl: string, deployment: Deployment): string {
  const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
  const body = JSON.stringify({ model: deployment.alias, messages: [{ role: 'user', content: '배송은 얼마나 걸리나요?' }], stream: false });
  return [`curl ${quote(`${baseUrl.replace(/\/$/, '')}/chat/completions`)}`, '  -H "Authorization: Bearer $AEGIS_API_KEY"', '  -H "Content-Type: application/json"', `  -d ${quote(body)}`].join(' \\\n');
}
