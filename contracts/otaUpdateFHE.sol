pragma solidity ^0.8.24;

import { FHE, euint32, ebool } from "@fhevm/solidity/lib/FHE.sol";
import { SepoliaConfig } from "@fhevm/solidity/config/ZamaConfig.sol";

contract OtaUpdateFHE is SepoliaConfig {
    using FHE for euint32;
    using FHE for ebool;

    address public owner;
    mapping(address => bool) public isProvider;
    bool public paused;
    uint256 public cooldownSeconds;
    mapping(address => uint256) public lastSubmissionTime;
    mapping(address => uint256) public lastDecryptionRequestTime;

    struct Batch {
        uint256 id;
        bool isOpen;
        uint256 updatePackageIdEncrypted;
        uint256 vehicleIdEncrypted;
        uint256 timestamp;
    }
    mapping(uint256 => Batch) public batches;
    uint256 public currentBatchId;
    uint256 public totalBatches;

    struct DecryptionContext {
        uint256 batchId;
        bytes32 stateHash;
        bool processed;
    }
    mapping(uint256 => DecryptionContext) public decryptionContexts;

    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
    event ProviderAdded(address indexed provider);
    event ProviderRemoved(address indexed provider);
    event Paused(address account);
    event Unpaused(address account);
    event CooldownSecondsSet(uint256 oldCooldownSeconds, uint256 newCooldownSeconds);
    event BatchOpened(uint256 indexed batchId, uint256 timestamp);
    event BatchClosed(uint256 indexed batchId, uint256 timestamp);
    event UpdateSubmitted(uint256 indexed batchId, address indexed provider, uint256 updatePackageIdEncrypted, uint256 vehicleIdEncrypted, uint256 timestamp);
    event DecryptionRequested(uint256 indexed requestId, uint256 indexed batchId, bytes32 stateHash);
    event DecryptionCompleted(uint256 indexed requestId, uint256 indexed batchId, uint256 updatePackageId, uint256 vehicleId, uint256 timestamp);

    error NotOwner();
    error NotProvider();
    error PausedState();
    error CooldownActive();
    error BatchClosedOrInvalid();
    error InvalidBatchId();
    error ReplayAttempt();
    error StateMismatch();
    error DecryptionFailed();
    error NotInitialized();
    error InvalidParameter();

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier onlyProvider() {
        if (!isProvider[msg.sender]) revert NotProvider();
        _;
    }

    modifier whenNotPaused() {
        if (paused) revert PausedState();
        _;
    }

    modifier respectCooldown(address _address, mapping(address => uint256) storage _lastTime) {
        if (block.timestamp < _lastTime[_address] + cooldownSeconds) {
            revert CooldownActive();
        }
        _;
    }

    constructor() {
        owner = msg.sender;
        isProvider[owner] = true;
        cooldownSeconds = 60; 
        currentBatchId = 1;
        totalBatches = 0;
        emit ProviderAdded(owner);
    }

    function transferOwnership(address newOwner) external onlyOwner {
        require(newOwner != address(0), "New owner is zero address");
        emit OwnershipTransferred(owner, newOwner);
        owner = newOwner;
    }

    function addProvider(address provider) external onlyOwner {
        if (provider == address(0)) revert InvalidParameter();
        if (!isProvider[provider]) {
            isProvider[provider] = true;
            emit ProviderAdded(provider);
        }
    }

    function removeProvider(address provider) external onlyOwner {
        if (isProvider[provider]) {
            isProvider[provider] = false;
            emit ProviderRemoved(provider);
        }
    }

    function pause() external onlyOwner whenNotPaused {
        paused = true;
        emit Paused(msg.sender);
    }

    function unpause() external onlyOwner {
        if (!paused) revert PausedState(); // Already unpaused
        paused = false;
        emit Unpaused(msg.sender);
    }

    function setCooldownSeconds(uint256 newCooldownSeconds) external onlyOwner {
        emit CooldownSecondsSet(cooldownSeconds, newCooldownSeconds);
        cooldownSeconds = newCooldownSeconds;
    }

    function openBatch() external onlyProvider whenNotPaused respectCooldown(msg.sender, lastSubmissionTime) {
        if (batches[currentBatchId].isOpen) revert BatchClosedOrInvalid(); // Batch already open or invalid state
        batches[currentBatchId] = Batch({
            id: currentBatchId,
            isOpen: true,
            updatePackageIdEncrypted: 0, 
            vehicleIdEncrypted: 0,
            timestamp: block.timestamp
        });
        totalBatches++;
        lastSubmissionTime[msg.sender] = block.timestamp;
        emit BatchOpened(currentBatchId, block.timestamp);
    }

    function closeBatch(uint256 batchId) external onlyProvider whenNotPaused {
        if (batchId != currentBatchId) revert InvalidBatchId();
        Batch storage batch = batches[batchId];
        if (!batch.isOpen) revert BatchClosedOrInvalid();
        batch.isOpen = false;
        batch.timestamp = block.timestamp; 
        emit BatchClosed(batchId, block.timestamp);
        currentBatchId++;
    }

    function submitUpdate(
        uint256 batchId,
        euint32 encryptedUpdatePackageId,
        euint32 encryptedVehicleId
    ) external onlyProvider whenNotPaused respectCooldown(msg.sender, lastSubmissionTime) {
        if (batchId != currentBatchId) revert InvalidBatchId();
        Batch storage batch = batches[batchId];
        if (!batch.isOpen) revert BatchClosedOrInvalid();
        if (!encryptedUpdatePackageId.isInitialized()) revert NotInitialized();
        if (!encryptedVehicleId.isInitialized()) revert NotInitialized();

        batch.updatePackageIdEncrypted = encryptedUpdatePackageId.toUint256();
        batch.vehicleIdEncrypted = encryptedVehicleId.toUint256();
        batch.timestamp = block.timestamp; 
        lastSubmissionTime[msg.sender] = block.timestamp;
        emit UpdateSubmitted(batchId, msg.sender, batch.updatePackageIdEncrypted, batch.vehicleIdEncrypted, block.timestamp);
    }

    function requestBatchDecryption(uint256 batchId) external onlyProvider whenNotPaused respectCooldown(msg.sender, lastDecryptionRequestTime) {
        if (batchId >= currentBatchId || !batches[batchId].isOpen) revert InvalidBatchId(); // Must be a closed batch

        euint32 memory encryptedUpdatePackageId = euint32.wrap(batches[batchId].updatePackageIdEncrypted);
        euint32 memory encryptedVehicleId = euint32.wrap(batches[batchId].vehicleIdEncrypted);

        _initIfNeeded(encryptedUpdatePackageId);
        _initIfNeeded(encryptedVehicleId);

        bytes32[] memory cts = new bytes32[](2);
        cts[0] = encryptedUpdatePackageId.toBytes32();
        cts[1] = encryptedVehicleId.toBytes32();

        bytes32 stateHash = _hashCiphertexts(cts);
        uint256 requestId = FHE.requestDecryption(cts, this.myCallback.selector);

        decryptionContexts[requestId] = DecryptionContext({
            batchId: batchId,
            stateHash: stateHash,
            processed: false
        });
        lastDecryptionRequestTime[msg.sender] = block.timestamp;
        emit DecryptionRequested(requestId, batchId, stateHash);
    }

    function myCallback(
        uint256 requestId,
        bytes memory cleartexts,
        bytes memory proof
    ) public {
        if (decryptionContexts[requestId].processed) revert ReplayAttempt();

        uint256 batchId = decryptionContexts[requestId].batchId;
        Batch storage batch = batches[batchId];

        euint32 memory encryptedUpdatePackageId = euint32.wrap(batch.updatePackageIdEncrypted);
        euint32 memory encryptedVehicleId = euint32.wrap(batch.vehicleIdEncrypted);

        bytes32[] memory cts = new bytes32[](2);
        cts[0] = encryptedUpdatePackageId.toBytes32();
        cts[1] = encryptedVehicleId.toBytes32();

        bytes32 currentHash = _hashCiphertexts(cts);
        if (currentHash != decryptionContexts[requestId].stateHash) {
            revert StateMismatch();
        }

        if (!FHE.checkSignatures(requestId, cleartexts, proof)) {
            revert DecryptionFailed();
        }

        uint256 updatePackageId = abi.decode(cleartexts[0:32], (uint256));
        uint256 vehicleId = abi.decode(cleartexts[32:64], (uint256));

        decryptionContexts[requestId].processed = true;
        emit DecryptionCompleted(requestId, batchId, updatePackageId, vehicleId, block.timestamp);
    }

    function _hashCiphertexts(bytes32[] memory cts) internal pure returns (bytes32) {
        return keccak256(abi.encode(cts, address(this)));
    }

    function _initIfNeeded(euint32 s) internal {
        if (!s.isInitialized()) {
            revert NotInitialized();
        }
    }

    function _requireInitialized(euint32 s) internal view {
        if (!s.isInitialized()) {
            revert NotInitialized();
        }
    }
}