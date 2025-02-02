/* eslint-disable no-restricted-syntax */
/* eslint-disable max-len */
const { Scalar } = require('ffjavascript');
const fs = require('fs');
const path = require('path');
const { ethers } = require('hardhat');
const { expect } = require('chai');
const { argv } = require('yargs');

const {
    MemDB, stateUtils, contractUtils, ZkEVMDB, processorUtils,
    getPoseidon, smtUtils,
} = require('@0xpolygonhermez/zkevm-commonjs');

const { rawTxToCustomRawTx } = processorUtils;

const { calculateSnarkInput, calculateBatchHashData } = contractUtils;

const {
    ERC20PermitMock, PolygonZkEVMGlobalExitRootMock, PolygonZkEVMBridge, PolygonZkEVMMock, VerifierRollupHelperMock,
} = require('@0xpolygonhermez/zkevm-contracts');

const { pathTestVectors } = require('../../helpers/helpers');

const pathStateTransition = path.join(pathTestVectors, './state-transition/no-data/general.json');
const testVectors = JSON.parse(fs.readFileSync(pathStateTransition));

async function takeSnapshop() {
    return (ethers.provider.send('evm_snapshot', []));
}

async function revertToSnapshot(snapshotId) {
    const revert = await ethers.provider.send('evm_revert', [snapshotId]);
    return revert;
}

async function setNextBlockTimestamp(timestamp) {
    return (ethers.provider.send('evm_setNextBlockTimestamp', [timestamp]));
}

describe('Proof of efficiency test vectors', function () {
    this.timeout(20000);

    let update;
    let poseidon;
    let F;

    let deployer;
    let trustedAggregator;
    let admin;
    let verifierContract;
    let bridgeContract;
    let polygonZkEVMContract;
    let maticTokenContract;
    let globalExitRootManager;

    const maticTokenName = 'Matic Token';
    const maticTokenSymbol = 'MATIC';
    const maticTokenInitialBalance = ethers.utils.parseEther('20000000');
    const networkIDMainnet = 0;
    const networkName = 'zkevm';
    const pendingStateTimeoutDefault = 10;
    const trustedAggregatorTimeoutDefault = 10;
    const initChainID = 1000;

    const genesisRootSC = '0x0000000000000000000000000000000000000000000000000000000000000000';

    before(async () => {
        update = argv.update === true;
    });

    beforeEach('Deploy contract', async () => {
        // build poseidon
        poseidon = await getPoseidon();
        F = poseidon.F;

        // load signers
        [deployer, trustedAggregator, admin] = await ethers.getSigners();

        // deploy mock verifier
        const VerifierRollupHelperFactory = new ethers.ContractFactory(VerifierRollupHelperMock.abi, VerifierRollupHelperMock.bytecode, deployer);
        verifierContract = await VerifierRollupHelperFactory.deploy();

        // deploy MATIC
        const maticTokenFactory = new ethers.ContractFactory(ERC20PermitMock.abi, ERC20PermitMock.bytecode, deployer);
        maticTokenContract = await maticTokenFactory.deploy(
            maticTokenName,
            maticTokenSymbol,
            deployer.address,
            maticTokenInitialBalance,
        );
        await maticTokenContract.deployed();

        const precalculatBridgeAddress = await ethers.utils.getContractAddress(
            { from: deployer.address, nonce: (await ethers.provider.getTransactionCount(deployer.address)) + 1 },
        );

        const precalculatezkEVMAddress = await ethers.utils.getContractAddress(
            { from: deployer.address, nonce: (await ethers.provider.getTransactionCount(deployer.address)) + 2 },
        );

        // deploy global exit root manager
        const globalExitRootManagerFactory = new ethers.ContractFactory(PolygonZkEVMGlobalExitRootMock.abi, PolygonZkEVMGlobalExitRootMock.bytecode, deployer);
        globalExitRootManager = await globalExitRootManagerFactory.deploy(precalculatezkEVMAddress, precalculatBridgeAddress);
        await globalExitRootManager.deployed();

        // deploy bridge
        const bridgeFactory = new ethers.ContractFactory(PolygonZkEVMBridge.abi, PolygonZkEVMBridge.bytecode, deployer);
        bridgeContract = await bridgeFactory.deploy();
        await bridgeContract.deployed();

        // deploy proof of efficiency
        const allowForcebatches = true;
        const urlSequencer = 'https://testURl';

        const ProofOfEfficiencyFactory = new ethers.ContractFactory(PolygonZkEVMMock.abi, PolygonZkEVMMock.bytecode, deployer);
        polygonZkEVMContract = await ProofOfEfficiencyFactory.deploy();
        await polygonZkEVMContract.deployed();

        await bridgeContract.initialize(networkIDMainnet, globalExitRootManager.address, polygonZkEVMContract.address);
        await polygonZkEVMContract.initialize(
            globalExitRootManager.address,
            maticTokenContract.address,
            verifierContract.address,
            bridgeContract.address,
            {
                admin: admin.address,
                chainID: initChainID,
                trustedSequencer: testVectors[0].sequencerAddress,
                pendingStateTimeout: pendingStateTimeoutDefault,
                forceBatchAllowed: allowForcebatches,
                trustedAggregator: trustedAggregator.address,
                trustedAggregatorTimeout: trustedAggregatorTimeoutDefault,
            },
            genesisRootSC,
            urlSequencer,
            networkName,
        );
        await polygonZkEVMContract.deployed();

        /*
        * /////////////////////////////////////////////////
        * // User interact with the bridge jsut to set to 1 the globalExitRootNum
        * /////////////////////////////////////////////////
        */

        // Add a claim leaf to rollup exit tree
        const claimAddress = '0xC949254d682D8c9ad5682521675b8F43b102aec4';
        const tokenAddress = ethers.constants.AddressZero; // ether
        const amount = ethers.utils.parseEther('10');
        const destinationNetwork = 1;
        const destinationAddress = claimAddress;
        await expect(bridgeContract.bridgeAsset(tokenAddress, destinationNetwork, destinationAddress, amount, '0x', { value: amount }));
    });

    for (let i = 0; i < testVectors.length; i++) {
        const {
            id,
            genesis,
            expectedOldRoot,
            txs,
            expectedNewRoot,
            sequencerAddress,
            expectedNewLeafs,
            batchL2Data,
            oldAccInputHash,
            globalExitRoot,
            batchHashData,
            inputHash,
            timestamp,
            chainID,
        } = testVectors[i];
        // eslint-disable-next-line no-loop-func
        it(`Test vectors id: ${id}`, async () => {
            const snapshotID = await takeSnapshop();

            const db = new MemDB(F);

            const walletMap = {};
            const addressArray = [];
            const amountArray = [];
            const nonceArray = [];

            // create genesis block
            for (let j = 0; j < genesis.length; j++) {
                const {
                    address, pvtKey, balance, nonce,
                } = genesis[j];

                const newWallet = new ethers.Wallet(pvtKey);
                expect(address).to.be.equal(newWallet.address);

                walletMap[address] = newWallet;
                addressArray.push(address);
                amountArray.push(Scalar.e(balance));
                nonceArray.push(Scalar.e(nonce));
            }

            /*
             * build, sign transaction and generate rawTxs
             * rawTxs would be the calldata inserted in the contract
             */
            const txProcessed = [];
            const rawTxs = [];
            for (let j = 0; j < txs.length; j++) {
                const txData = txs[j];
                const tx = {
                    to: txData.to,
                    nonce: txData.nonce,
                    value: ethers.utils.parseUnits(txData.value, 'wei'),
                    gasLimit: txData.gasLimit,
                    gasPrice: ethers.utils.parseUnits(txData.gasPrice, 'wei'),
                    chainId: txData.chainId,
                    data: txData.data || '0x',
                };

                try {
                    let rawTxEthers = await walletMap[txData.from].signTransaction(tx);
                    // apply overwrite
                    if (txData.overwrite) {
                        const txFields = ethers.utils.RLP.decode(rawTxEthers);
                        const txDecoded = {
                            nonce: txFields[0],
                            gasPrice: txFields[1],
                            gasLimit: txFields[2],
                            to: txFields[3],
                            value: txFields[4],
                            data: txFields[5],
                            v: txFields[6],
                            r: txFields[7],
                            s: txFields[8],
                        };

                        for (const paramOverwrite of Object.keys(txData.overwrite)) {
                            txDecoded[paramOverwrite] = txData.overwrite[paramOverwrite];
                        }

                        rawTxEthers = ethers.utils.RLP.encode([
                            txDecoded.nonce,
                            txDecoded.gasPrice,
                            txDecoded.gasLimit,
                            txDecoded.to,
                            txDecoded.value,
                            txDecoded.data,
                            txDecoded.v,
                            txDecoded.r,
                            txDecoded.s,
                        ]);
                    }

                    const customRawTx = rawTxToCustomRawTx(rawTxEthers);

                    if (update) {
                        testVectors[i].txs[j].customRawTx = customRawTx;
                        testVectors[i].txs[j].rawTx = rawTxEthers;
                    } else {
                        expect(txData.rawTx).to.equal(rawTxEthers);
                        expect(txData.customRawTx).to.equal(customRawTx);
                    }
                    rawTxs.push(customRawTx);
                    txProcessed.push(txData);
                } catch (error) {
                    expect(txData.customRawTx).to.equal(undefined);
                }
            }

            // create a zkEVMDB and build a batch
            const zkEVMDB = await ZkEVMDB.newZkEVM(
                db,
                poseidon,
                [F.zero, F.zero, F.zero, F.zero],
                smtUtils.stringToH4(oldAccInputHash),
                genesis,
                null,
                null,
                chainID,
            );

            // check genesis root
            for (let j = 0; j < addressArray.length; j++) {
                const currentState = await stateUtils.getState(addressArray[j], zkEVMDB.smt, zkEVMDB.stateRoot);

                expect(currentState.balance).to.be.equal(amountArray[j]);
                expect(currentState.nonce).to.be.equal(nonceArray[j]);
            }

            if (update) {
                testVectors[i].expectedOldRoot = smtUtils.h4toString(zkEVMDB.stateRoot);
            } else {
                expect(smtUtils.h4toString(zkEVMDB.stateRoot)).to.be.equal(expectedOldRoot);
            }

            const batch = await zkEVMDB.buildBatch(timestamp, sequencerAddress, smtUtils.stringToH4(globalExitRoot));
            for (let j = 0; j < rawTxs.length; j++) {
                batch.addRawTx(rawTxs[j]);
            }

            // execute the transactions added to the batch
            await batch.executeTxs();

            const newRoot = batch.currentStateRoot;

            if (update) {
                testVectors[i].expectedNewRoot = smtUtils.h4toString(newRoot);
            } else {
                expect(smtUtils.h4toString(newRoot)).to.be.equal(expectedNewRoot);
            }

            // consoldate state
            await zkEVMDB.consolidate(batch);

            // Check balances and nonces
            for (const [address, leaf] of Object.entries(expectedNewLeafs)) { // eslint-disable-line
                const newLeaf = await zkEVMDB.getCurrentAccountState(address);

                if (update) {
                    const newLeafState = { balance: newLeaf.balance.toString(), nonce: newLeaf.nonce.toString() };
                    testVectors[i].expectedNewLeafs[address] = newLeafState;
                } else {
                    expect(newLeaf.balance.toString()).to.equal(leaf.balance);
                    expect(newLeaf.nonce.toString()).to.equal(leaf.nonce);
                }
            }

            // Check errors on decode transactions
            const decodedTx = await batch.getDecodedTxs();

            for (let j = 0; j < decodedTx.length; j++) {
                const currentTx = decodedTx[j];
                const expectedTx = txProcessed[j];
                try {
                    if (update) {
                        testVectors[i].txs[j].reason = currentTx.reason;
                    } else {
                        expect(currentTx.reason).to.be.equal(expectedTx.reason);
                    }
                } catch (error) {
                    // eslint-disable-next-line no-console
                    console.log({ currentTx }, { expectedTx });
                    throw new Error(`Batch Id : ${id} TxId:${expectedTx.id} ${error}`);
                }
            }

            // Check the circuit input
            const circuitInput = await batch.getStarkInput();

            if (update) {
                testVectors[i].batchL2Data = batch.getBatchL2Data();
                testVectors[i].batchHashData = circuitInput.batchHashData;
                testVectors[i].inputHash = circuitInput.inputHash;
                testVectors[i].globalExitRoot = circuitInput.globalExitRoot;
                testVectors[i].oldLocalExitRoot = circuitInput.oldLocalExitRoot;
                testVectors[i].newLocalExitRoot = circuitInput.newLocalExitRoot;
            } else {
                // Check the encode transaction match with the vector test
                expect(batchL2Data).to.be.equal(batch.getBatchL2Data());

                // Check the batchHashData and the input hash
                expect(batchHashData).to.be.equal(circuitInput.batchHashData);
                expect(inputHash).to.be.equal(circuitInput.inputHash);
            }

            /*
             * /////////////////////////////////////////////////
             * // Check against the smart contracts
             * /////////////////////////////////////////////////
             */
            if (!update) {
                const currentStateRoot = `0x${Scalar.e(expectedOldRoot).toString(16).padStart(64, '0')}`;
                const newStateRoot = `0x${Scalar.e(expectedNewRoot).toString(16).padStart(64, '0')}`;
                const newLocalExitRoot = `0x${Scalar.e(oldAccInputHash).toString(16).padStart(64, '0')}`;
                const currentGlobalExitRoot = `0x${Scalar.e(globalExitRoot).toString(16).padStart(64, '0')}`;

                const walletSequencer = walletMap[sequencerAddress].connect(ethers.provider);
                const aggregatorAddress = trustedAggregator.address;

                // fund sequencer address with Matic tokens and ether
                await maticTokenContract.transfer(sequencerAddress, ethers.utils.parseEther('100'));
                await deployer.sendTransaction({
                    to: sequencerAddress,
                    value: ethers.utils.parseEther('10.0'),
                });

                // fund sequencer address with Matic tokens and ether
                await maticTokenContract.transfer(sequencerAddress, ethers.utils.parseEther('100'));

                // set roots to the contract:
                await polygonZkEVMContract.setStateRoot(currentStateRoot, batch.oldNumBatch);
                await globalExitRootManager.setGlobalExitRoot(currentGlobalExitRoot, batch.timestamp);

                // sequencer send the batch
                const lastBatchSequenced = await polygonZkEVMContract.lastBatchSequenced();
                const l2txData = batchL2Data;
                const maticAmount = await polygonZkEVMContract.getCurrentBatchFee();

                await expect(
                    maticTokenContract.connect(walletSequencer).approve(polygonZkEVMContract.address, maticAmount),
                ).to.emit(maticTokenContract, 'Approval');

                // set timestamp for the sendBatch call
                if ((await ethers.provider.getBlock()).timestamp < timestamp) {
                    await setNextBlockTimestamp(timestamp);
                }

                const sequence = {
                    transactions: l2txData,
                    globalExitRoot: currentGlobalExitRoot,
                    timestamp,
                    minForcedTimestamp: 0,
                };
                await expect(polygonZkEVMContract.connect(walletSequencer).sequenceBatches([sequence]))
                    .to.emit(polygonZkEVMContract, 'SequenceBatches')
                    .withArgs(lastBatchSequenced + 1);

                // Check inputs mathces de smart contract
                const numBatch = (await polygonZkEVMContract.lastVerifiedBatch()) + 1;
                const proofA = ['0', '0'];
                const proofB = [
                    ['0', '0'],
                    ['0', '0'],
                ];
                const proofC = ['0', '0'];

                // check batch sent
                const { accInputHash } = await polygonZkEVMContract.sequencedBatches(1);

                expect(accInputHash).to.be.equal(circuitInput.newAccInputHash);
                const batchHashDataSC = calculateBatchHashData(
                    l2txData,
                );
                expect(batchHashData).to.be.equal(batchHashDataSC);
                const pendingStateNum = 0;

                // calculate circuit input
                const nextSnarkInput = await polygonZkEVMContract.connect(trustedAggregator).getNextSnarkInput(
                    pendingStateNum,
                    numBatch - 1,
                    numBatch,
                    newLocalExitRoot,
                    newStateRoot,
                );

                // Compute Js input
                const circuitInputJS = await calculateSnarkInput(
                    currentStateRoot,
                    newStateRoot,
                    newLocalExitRoot,
                    oldAccInputHash,
                    circuitInput.newAccInputHash,
                    numBatch - 1,
                    numBatch,
                    chainID,
                    trustedAggregator.address,
                );
                const nextSnarkInputHex = `0x${Scalar.e(nextSnarkInput).toString(16).padStart(64, '0')}`;
                const circuitInputJSHex = `0x${Scalar.e(circuitInputJS).toString(16).padStart(64, '0')}`;
                expect(nextSnarkInputHex).to.be.equal(circuitInputJSHex);

                // Forge the batch
                const initialAggregatorMatic = await maticTokenContract.balanceOf(
                    await trustedAggregator.getAddress(),
                );

                await expect(
                    polygonZkEVMContract.connect(trustedAggregator).trustedVerifyBatches(
                        pendingStateNum,
                        numBatch - 1,
                        numBatch,
                        newLocalExitRoot,
                        newStateRoot,
                        proofA,
                        proofB,
                        proofC,
                    ),
                ).to.emit(polygonZkEVMContract, 'TrustedVerifyBatches')
                    .withArgs(numBatch, newStateRoot, aggregatorAddress);

                const finalAggregatorMatic = await maticTokenContract.balanceOf(
                    await trustedAggregator.getAddress(),
                );
                expect(finalAggregatorMatic).to.equal(
                    ethers.BigNumber.from(initialAggregatorMatic).add(ethers.BigNumber.from(maticAmount)),
                );
                expect(await revertToSnapshot(snapshotID)).to.be.equal(true);
            }
        });
    }

    after(async () => {
        if (update) {
            fs.writeFileSync(pathStateTransition, JSON.stringify(testVectors, null, 2));
        }
    });
});
