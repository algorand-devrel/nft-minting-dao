/* eslint-disable no-alert */
import * as algokit from '@algorandfoundation/algokit-utils';
import { ApplicationClient } from '@algorandfoundation/algokit-utils/types/app-client';
import algosdk from 'algosdk';
import daoAppSpec from '../../artifacts/DAO/application.json';
import minterAppSpec from '../../artifacts/Minter/application.json'
import PeraSession from './wallets/pera';

declare let NETWORK : 'localnet' | 'testnet';

const BOX_CREATE_COST = 0.0025e6;
const BOX_BYTE_COST = 0.0004e6;

const pera = new PeraSession();

const algodClient = algokit.getAlgoClient(NETWORK === 'localnet' ? algokit.getDefaultLocalNetConfig('algod') : algokit.getAlgoNodeConfig('testnet', 'algod'));
const indexerClient = algokit.getAlgoIndexerClient(NETWORK === 'localnet' ? algokit.getDefaultLocalNetConfig('indexer') : algokit.getAlgoNodeConfig('testnet', 'indexer'));
const kmdClient = NETWORK === 'localnet' ? new algosdk.Kmd('a'.repeat(64), 'http://localhost', 4002) : undefined;

let daoAppId: number;
let daoApp: ApplicationClient;
let minterAppId: number;

const accountsMenu = document.getElementById('accounts') as HTMLSelectElement;

const urlInput = document.getElementById('url') as HTMLInputElement;
const hashInput = document.getElementById('hash') as HTMLInputElement;
const nameInput = document.getElementById('name') as HTMLInputElement;
const unitNameInput = document.getElementById('unit') as HTMLInputElement;
const reserveInput = document.getElementById('reserve') as HTMLInputElement;
const proposerInput = document.getElementById('proposer') as HTMLInputElement;
const idInput = document.getElementById('id') as HTMLInputElement;

const buttonIds = ['connect', 'create', 'submit', 'vote', 'mint'];
const buttons: { [key: string]: HTMLButtonElement } = {};
buttonIds.forEach((id) => {
  buttons[id] = document.getElementById(id) as HTMLButtonElement;
});

async function signer(txns: algosdk.Transaction[]) {
  if (NETWORK === 'localnet') {
    const acct = await algokit.getDispenserAccount(algodClient, kmdClient);
    return algosdk.makeBasicAccountTransactionSigner(acct)(txns, txns.map((_, i) => i));
  }

  return pera.signTxns(txns);
}

buttons.connect.onclick = async () => {
  if (NETWORK === 'localnet') {
    const acct = await algokit.getDispenserAccount(algodClient, kmdClient);
    accountsMenu.add(new Option(acct.addr, acct.addr));
  } else {
    await pera.getAccounts();
    pera.accounts.forEach((account) => {
      accountsMenu.add(new Option(account, account));
    });
  }

  buttons.create.disabled = false;
};

buttons.create.onclick = async () => {
  document.getElementById('status').innerHTML = 'Creating DAO...';
  const sender = {
    addr: accountsMenu.selectedOptions[0].value,
    signer,
  };

  if (!minterAppId) {
    console.log('Creating minter')
    const minterApp = algokit.getAppClient(
      {
        app: JSON.stringify(minterAppSpec),
        sender,
        id: 0
      },
      algodClient,
    );

    await minterApp.create();
    await minterApp.fundAppAccount(algokit.microAlgos(100_000))
    minterAppId = (await minterApp.getAppReference()).appId;
  }

  daoApp = algokit.getAppClient(
    {
      app: JSON.stringify(daoAppSpec),
      sender,
      creatorAddress: sender.addr,
      indexer: indexerClient,
      name: `dao-${Date.now()}`
    },
    algodClient,
  );

  const { appId, appAddress } = await daoApp.deploy({sender, deployTimeParams: {'MINTER_APP': minterAppId}});

  daoAppId = appId;

  document.getElementById('status').innerHTML = `App created with id ${appId} and address ${appAddress}. See it <a href='https://app.dappflow.org/explorer/application/${appId}'>here</a>`;

  reserveInput.value = appAddress;
  buttons.submit.disabled = false;
  buttons.create.disabled = true;
};

buttons.submit.onclick = async () => {
  document.getElementById('status').innerHTML = 'Sending proposal...';
  const sender = {
    addr: accountsMenu.selectedOptions[0].value,
    signer,
  };

  const proposalObject = {
    url: urlInput.value,
    hash: Buffer.from(hashInput.value, 'hex'),
    name: nameInput.value,
    unitName: unitNameInput.value,
    reserve: reserveInput.value,
  };

  const proposalId = (await daoApp.getBoxNames()).filter((b) => {
    // filter out non proposal boxes
    if (!b.name.startsWith('p-')) return false;
    // filter out proposals that aren't from the sender
    return algosdk.encodeAddress(b.nameRaw.slice(2, 34)) === sender.addr;
  }).length;

  const proposalKeyType = algosdk.ABIType.from('(address,uint64)');
  const proposalKeyPrefix = new Uint8Array(Buffer.from('p-'));
  const proposalKey = new Uint8Array([
    ...proposalKeyPrefix,
    ...proposalKeyType.encode([sender.addr, proposalId]),
  ]);

  const boxMbr = BOX_CREATE_COST + (Object.values(proposalObject)
    .reduce((totalLength, v) => totalLength + v.length, 0) + proposalKey.byteLength
  ) * BOX_BYTE_COST;

  const payment = algosdk.makePaymentTxnWithSuggestedParamsFromObject({
    suggestedParams: await algodClient.getTransactionParams().do(),
    amount: 100_000 + boxMbr,
    from: sender.addr,
    to: algosdk.getApplicationAddress(daoAppId),
  });

  const args = [Object.values(proposalObject), proposalId, { txn: payment, signer }];

  proposerInput.value = sender.addr;

  await daoApp.call({
    method: 'add_proposal',
    methodArgs: { args, boxes: [{ appIndex: 0, name: proposalKey }] },
    sender,
  });

  buttons.vote.disabled = false;
  document.getElementById('status').innerHTML = `Proposal submitted! See the app <a href='https://app.dappflow.org/explorer/application/${daoAppId}'>here</a>`;
};

buttons.vote.onclick = async () => {
  const sender = {
    addr: accountsMenu.selectedOptions[0].value,
    signer,
  };

  const proposalKeyType = algosdk.ABIType.from('(address,uint64)');
  const encodedKey = proposalKeyType.encode([sender.addr, idInput.valueAsNumber]);
  const proposalKey = new Uint8Array([
    ...new Uint8Array(Buffer.from('p-')),
    ...encodedKey,
  ]);

  const proposalBox = (await daoApp.getBoxNames()).find((b) => b.nameBase64 === Buffer.from(proposalKey).toString('base64'));

  if (!proposalBox) {
    alert('Proposal not found!');
    return;
  }

  const votesKey = new Uint8Array([
    ...new Uint8Array(Buffer.from('v-')),
    ...encodedKey,
  ]);

  const hasVotedKey = algosdk.decodeAddress(sender.addr).publicKey


  const hasVoted = (await daoApp.getBoxNames()).find((b) => {
    // filter out non has_voted boxes
    if (b.nameRaw.byteLength !== 32) return false;
    // filter out has_voted boxes that don't aren't for the sender
    return algosdk.encodeAddress(b.nameRaw) === sender.addr;
  });

  if (hasVoted) {
    alert('You have already voted!');
    return;
  }

  await daoApp.fundAppAccount(algokit.microAlgos(33400));

  await daoApp.call({
    method: 'vote',
    methodArgs: {
      args: [proposerInput.value, idInput.valueAsNumber],
      boxes: [
        { appIndex: 0, name: proposalKey },
        { appIndex: 0, name: votesKey },
        { appIndex: 0, name: hasVotedKey },

      ],
    },
    sender,
  });

  document.getElementById('status').innerHTML = `Vote submitted! See the app <a href='https://app.dappflow.org/explorer/application/${daoAppId}'>here</a>`;
  buttons.mint.disabled = false;
};

buttons.mint.onclick = async () => {
  const sender = {
    addr: accountsMenu.selectedOptions[0].value,
    signer,
  };

  const sdkMint = algosdk.makeAssetCreateTxnWithSuggestedParamsFromObject({
    from: sender.addr,
    suggestedParams: await algodClient.getTransactionParams().do(),
    total: 0,
    decimals: 0,
    defaultFrozen: false,
    unitName: unitNameInput.value,
    assetName: nameInput.value,
  });

  const sdkAtc = new algosdk.AtomicTransactionComposer();

  sdkAtc.addTransaction({txn: sdkMint, signer })

  const res = await sdkAtc.execute(algodClient, 3)

  console.log(res.txIDs)

  const winningProposalKey = (await daoApp.getGlobalState())
    .winning_proposal
    // @ts-ignore
    .valueRaw as Uint8Array;

  const proposalKey = new Uint8Array([
    ...new Uint8Array(Buffer.from('p-')),
    ...winningProposalKey,
  ]);


  const atc = new algosdk.AtomicTransactionComposer();

  atc.addTransaction({
    txn: algosdk.makePaymentTxnWithSuggestedParamsFromObject({
      suggestedParams: await algodClient.getTransactionParams().do(),
      from: sender.addr,
      to: algosdk.getApplicationAddress(minterAppId),
      amount: 100_000,
    }), 
    signer
  })

  atc.addMethodCall({
    method: daoApp.getABIMethod('mint'),
    suggestedParams: {...(await algodClient.getTransactionParams().do()), fee: 3_000, flatFee: true},
    methodArgs: [minterAppId],
    boxes: [{ appIndex: 0, name: proposalKey }],
    sender: sender.addr,
    signer,
    appID: daoAppId,
  })

  const assetID = (await atc.execute(algodClient, 3)).methodResults[0].returnValue;

  document.getElementById('status').innerHTML = `NFT minted! See the asset <a href='https://app.dappflow.org/explorer/asset/${assetID}'>here</a>`;
  buttons.mint.disabled = true
  buttons.vote.disabled = true;
  buttons.submit.disabled = true;
};
