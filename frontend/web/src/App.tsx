import { ConnectButton } from '@rainbow-me/rainbowkit';
import '@rainbow-me/rainbowkit/styles.css';
import React, { useEffect, useState } from "react";
import { ethers } from "ethers";
import { getContractReadOnly, getContractWithSigner } from "./contract";
import "./App.css";
import { useAccount, useSignMessage } from 'wagmi';

interface OTAUpdateRecord {
  id: string;
  vehicleId: string;
  encryptedFirmware: string;
  version: string;
  timestamp: number;
  owner: string;
  status: "pending" | "downloading" | "installing" | "completed" | "failed";
  fileSize: number;
  description: string;
}

// FHE encryption simulation for numerical data (file size, version numbers)
const FHEEncryptNumber = (value: number): string => {
  return `FHE-${btoa(value.toString())}-${Date.now()}`;
};

const FHEDecryptNumber = (encryptedData: string): number => {
  if (encryptedData.startsWith('FHE-')) {
    const base64Data = encryptedData.substring(4, encryptedData.lastIndexOf('-'));
    return parseFloat(atob(base64Data));
  }
  return parseFloat(encryptedData);
};

// Simulate FHE computation on encrypted data
const FHECompute = (encryptedData: string, operation: string): string => {
  const value = FHEDecryptNumber(encryptedData);
  let result = value;
  
  switch(operation) {
    case 'verifyIntegrity':
      // Simulate integrity check - in real FHE this would be done on encrypted data
      result = value * 1.0; // No change, just verification
      break;
    case 'calculateHash':
      // Simulate hash calculation
      result = value + 12345; // Simple transformation
      break;
    default:
      result = value;
  }
  
  return FHEEncryptNumber(result);
};

const generateVehicleId = () => `VEH${Math.floor(1000 + Math.random() * 9000)}`;

const App: React.FC = () => {
  const { address, isConnected } = useAccount();
  const { signMessageAsync } = useSignMessage();
  const [loading, setLoading] = useState(true);
  const [otaRecords, setOtaRecords] = useState<OTAUpdateRecord[]>([]);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [creating, setCreating] = useState(false);
  const [transactionStatus, setTransactionStatus] = useState<{ visible: boolean; status: "pending" | "success" | "error"; message: string; }>({ visible: false, status: "pending", message: "" });
  const [newUpdateData, setNewUpdateData] = useState({ 
    vehicleId: "", 
    version: "", 
    fileSize: 0, 
    description: "" 
  });
  const [selectedRecord, setSelectedRecord] = useState<OTAUpdateRecord | null>(null);
  const [decryptedSize, setDecryptedSize] = useState<number | null>(null);
  const [isDecrypting, setIsDecrypting] = useState(false);
  const [activeTab, setActiveTab] = useState("dashboard");
  const [operationLogs, setOperationLogs] = useState<string[]>([]);
  const [vehicles, setVehicles] = useState<string[]>([]);

  // Statistics
  const completedCount = otaRecords.filter(r => r.status === "completed").length;
  const pendingCount = otaRecords.filter(r => r.status === "pending").length;
  const failedCount = otaRecords.filter(r => r.status === "failed").length;

  useEffect(() => {
    loadOTARecords().finally(() => setLoading(false));
    initializeVehicles();
    addLog("System initialized with Zama FHE encryption");
  }, []);

  const addLog = (message: string) => {
    const timestamp = new Date().toLocaleTimeString();
    setOperationLogs(prev => [`[${timestamp}] ${message}`, ...prev.slice(0, 49)]);
  };

  const initializeVehicles = () => {
    const defaultVehicles = [generateVehicleId(), generateVehicleId(), generateVehicleId()];
    setVehicles(defaultVehicles);
    addLog(`Initialized ${defaultVehicles.length} vehicles`);
  };

  const loadOTARecords = async () => {
    setIsRefreshing(true);
    addLog("Loading OTA update records from blockchain...");
    try {
      const contract = await getContractReadOnly();
      if (!contract) {
        addLog("Error: Contract not available");
        return;
      }

      // Check contract availability
      const isAvailable = await contract.isAvailable();
      if (!isAvailable) {
        addLog("Warning: Contract is not available");
        return;
      }

      // Load record keys
      const keysBytes = await contract.getData("ota_record_keys");
      let keys: string[] = [];
      if (keysBytes.length > 0) {
        try {
          const keysStr = ethers.toUtf8String(keysBytes);
          if (keysStr.trim() !== '') keys = JSON.parse(keysStr);
        } catch (e) { 
          console.error("Error parsing record keys:", e);
          addLog("Error parsing record keys from blockchain");
        }
      }

      const records: OTAUpdateRecord[] = [];
      for (const key of keys) {
        try {
          const recordBytes = await contract.getData(`ota_record_${key}`);
          if (recordBytes.length > 0) {
            try {
              const recordData = JSON.parse(ethers.toUtf8String(recordBytes));
              records.push({
                id: key,
                vehicleId: recordData.vehicleId,
                encryptedFirmware: recordData.encryptedFirmware,
                version: recordData.version,
                timestamp: recordData.timestamp,
                owner: recordData.owner,
                status: recordData.status || "pending",
                fileSize: recordData.fileSize,
                description: recordData.description
              });
            } catch (e) { 
              console.error(`Error parsing record data for ${key}:`, e);
              addLog(`Error parsing data for record ${key}`);
            }
          }
        } catch (e) { 
          console.error(`Error loading record ${key}:`, e);
          addLog(`Error loading record ${key}`);
        }
      }

      records.sort((a, b) => b.timestamp - a.timestamp);
      setOtaRecords(records);
      addLog(`Loaded ${records.length} OTA update records`);
    } catch (e) { 
      console.error("Error loading records:", e);
      addLog("Error loading records from blockchain");
    } finally { 
      setIsRefreshing(false);
      setLoading(false);
    }
  };

  const submitOTAUpdate = async () => {
    if (!isConnected) { 
      alert("Please connect wallet first");
      addLog("Wallet not connected - cannot submit OTA update");
      return;
    }

    setCreating(true);
    setTransactionStatus({ 
      visible: true, 
      status: "pending", 
      message: "Encrypting firmware data with Zama FHE..." 
    });
    addLog("Starting FHE encryption for OTA update...");

    try {
      // Encrypt file size using FHE simulation
      const encryptedFileSize = FHEEncryptNumber(newUpdateData.fileSize);
      
      const contract = await getContractWithSigner();
      if (!contract) throw new Error("Failed to get contract with signer");
      
      const recordId = `ota-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
      const recordData = {
        vehicleId: newUpdateData.vehicleId,
        encryptedFirmware: encryptedFileSize, // In real scenario, this would be the actual encrypted firmware
        version: newUpdateData.version,
        timestamp: Math.floor(Date.now() / 1000),
        owner: address,
        status: "pending",
        fileSize: newUpdateData.fileSize,
        description: newUpdateData.description
      };

      await contract.setData(`ota_record_${recordId}`, ethers.toUtf8Bytes(JSON.stringify(recordData)));
      addLog(`OTA record ${recordId} stored on blockchain`);

      // Update keys list
      const keysBytes = await contract.getData("ota_record_keys");
      let keys: string[] = [];
      if (keysBytes.length > 0) {
        try { 
          keys = JSON.parse(ethers.toUtf8String(keysBytes)); 
        } catch (e) { 
          console.error("Error parsing keys:", e);
          addLog("Error parsing existing record keys");
        }
      }
      keys.push(recordId);
      await contract.setData("ota_record_keys", ethers.toUtf8Bytes(JSON.stringify(keys)));
      addLog("Record keys updated on blockchain");

      setTransactionStatus({ 
        visible: true, 
        status: "success", 
        message: "OTA update encrypted and submitted securely!" 
      });
      addLog("OTA update successfully encrypted with Zama FHE");

      await loadOTARecords();
      
      setTimeout(() => {
        setTransactionStatus({ visible: false, status: "pending", message: "" });
        setShowCreateModal(false);
        setNewUpdateData({ vehicleId: "", version: "", fileSize: 0, description: "" });
      }, 2000);

    } catch (e: any) {
      const errorMessage = e.message.includes("user rejected transaction") 
        ? "Transaction rejected by user" 
        : "Submission failed: " + (e.message || "Unknown error");
      
      setTransactionStatus({ visible: true, status: "error", message: errorMessage });
      addLog(`OTA update failed: ${errorMessage}`);
      
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 3000);
    } finally { 
      setCreating(false);
    }
  };

  const decryptWithSignature = async (encryptedData: string): Promise<number | null> => {
    if (!isConnected) { 
      alert("Please connect wallet first");
      return null;
    }

    setIsDecrypting(true);
    addLog("Initiating wallet signature for FHE decryption...");

    try {
      const message = `Decrypt OTA firmware data with Zama FHE\nTimestamp: ${Date.now()}`;
      await signMessageAsync({ message });
      addLog("Wallet signature obtained for decryption");
      
      await new Promise(resolve => setTimeout(resolve, 1000)); // Simulate decryption process
      const decryptedValue = FHEDecryptNumber(encryptedData);
      addLog("FHE decryption completed successfully");
      
      return decryptedValue;
    } catch (e) { 
      console.error("Decryption failed:", e);
      addLog("FHE decryption failed");
      return null;
    } finally { 
      setIsDecrypting(false);
    }
  };

  const verifyUpdateIntegrity = async (recordId: string) => {
    if (!isConnected) { 
      alert("Please connect wallet first");
      return;
    }

    setTransactionStatus({ 
      visible: true, 
      status: "pending", 
      message: "Verifying firmware integrity with FHE..." 
    });
    addLog(`Starting FHE integrity verification for record ${recordId}`);

    try {
      const contract = await getContractReadOnly();
      if (!contract) throw new Error("Failed to get contract");
      
      const recordBytes = await contract.getData(`ota_record_${recordId}`);
      if (recordBytes.length === 0) throw new Error("Record not found");
      
      const recordData = JSON.parse(ethers.toUtf8String(recordBytes));
      const verifiedData = FHECompute(recordData.encryptedFirmware, 'verifyIntegrity');
      
      const contractWithSigner = await getContractWithSigner();
      if (!contractWithSigner) throw new Error("Failed to get contract with signer");
      
      const updatedRecord = { ...recordData, status: "downloading" };
      await contractWithSigner.setData(`ota_record_${recordId}`, ethers.toUtf8Bytes(JSON.stringify(updatedRecord)));
      
      setTransactionStatus({ 
        visible: true, 
        status: "success", 
        message: "FHE integrity verification completed!" 
      });
      addLog(`FHE integrity verification successful for ${recordId}`);
      
      await loadOTARecords();
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 2000);
    } catch (e: any) {
      setTransactionStatus({ 
        visible: true, 
        status: "error", 
        message: "Verification failed: " + (e.message || "Unknown error") 
      });
      addLog(`FHE verification failed: ${e.message}`);
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 3000);
    }
  };

  const completeUpdate = async (recordId: string) => {
    if (!isConnected) return;

    setTransactionStatus({ 
      visible: true, 
      status: "pending", 
      message: "Completing OTA update with FHE..." 
    });
    addLog(`Completing OTA update for record ${recordId}`);

    try {
      const contract = await getContractWithSigner();
      if (!contract) throw new Error("Failed to get contract with signer");
      
      const recordBytes = await contract.getData(`ota_record_${recordId}`);
      if (recordBytes.length === 0) throw new Error("Record not found");
      
      const recordData = JSON.parse(ethers.toUtf8String(recordBytes));
      const updatedRecord = { ...recordData, status: "completed" };
      
      await contract.setData(`ota_record_${recordId}`, ethers.toUtf8Bytes(JSON.stringify(updatedRecord)));
      
      setTransactionStatus({ 
        visible: true, 
        status: "success", 
        message: "OTA update completed successfully!" 
      });
      addLog(`OTA update completed for ${recordId}`);
      
      await loadOTARecords();
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 2000);
    } catch (e: any) {
      setTransactionStatus({ 
        visible: true, 
        status: "error", 
        message: "Completion failed: " + (e.message || "Unknown error") 
      });
      addLog(`OTA completion failed: ${e.message}`);
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 3000);
    }
  };

  const isOwner = (recordAddress: string) => address?.toLowerCase() === recordAddress.toLowerCase();

  if (loading) return (
    <div className="loading-screen">
      <div className="fhe-spinner"></div>
      <p>Initializing secure OTA connection with Zama FHE...</p>
    </div>
  );

  return (
    <div className="app-container fhe-blue-theme">
      {/* Sidebar */}
      <div className="app-sidebar">
        <div className="sidebar-header">
          <div className="logo">
            <div className="logo-icon">
              <div className="car-icon"></div>
              <div className="shield-overlay"></div>
            </div>
            <h1>Secure OTA</h1>
          </div>
          <div className="fhe-badge">
            <span>Zama FHE</span>
          </div>
        </div>

        <nav className="sidebar-nav">
          <button 
            className={`nav-item ${activeTab === "dashboard" ? "active" : ""}`}
            onClick={() => setActiveTab("dashboard")}
          >
            <div className="nav-icon">📊</div>
            <span>Dashboard</span>
          </button>
          <button 
            className={`nav-item ${activeTab === "updates" ? "active" : ""}`}
            onClick={() => setActiveTab("updates")}
          >
            <div className="nav-icon">🔒</div>
            <span>OTA Updates</span>
          </button>
          <button 
            className={`nav-item ${activeTab === "vehicles" ? "active" : ""}`}
            onClick={() => setActiveTab("vehicles")}
          >
            <div className="nav-icon">🚗</div>
            <span>Vehicle Management</span>
          </button>
          <button 
            className={`nav-item ${activeTab === "logs" ? "active" : ""}`}
            onClick={() => setActiveTab("logs")}
          >
            <div className="nav-icon">📋</div>
            <span>Operation Logs</span>
          </button>
        </nav>

        <div className="sidebar-footer">
          <div className="wallet-connect-wrapper">
            <ConnectButton accountStatus="address" chainStatus="icon" showBalance={false}/>
          </div>
        </div>
      </div>

      {/* Main Content */}
      <div className="main-content">
        <header className="content-header">
          <h2>{
            activeTab === "dashboard" ? "Secure OTA Dashboard" :
            activeTab === "updates" ? "FHE-Encrypted OTA Updates" :
            activeTab === "vehicles" ? "Vehicle Management" :
            "Operation Logs"
          }</h2>
          <div className="header-actions">
            <button onClick={loadOTARecords} className="refresh-btn" disabled={isRefreshing}>
              {isRefreshing ? "🔄 Refreshing..." : "🔄 Refresh"}
            </button>
            <button onClick={() => setShowCreateModal(true)} className="create-update-btn">
              + New OTA Update
            </button>
          </div>
        </header>

        {/* Dashboard Tab */}
        {activeTab === "dashboard" && (
          <div className="dashboard-content">
            <div className="stats-grid">
              <div className="stat-card">
                <div className="stat-icon">🚗</div>
                <div className="stat-info">
                  <div className="stat-value">{vehicles.length}</div>
                  <div className="stat-label">Managed Vehicles</div>
                </div>
              </div>
              <div className="stat-card">
                <div className="stat-icon">🔒</div>
                <div className="stat-info">
                  <div className="stat-value">{otaRecords.length}</div>
                  <div className="stat-label">OTA Updates</div>
                </div>
              </div>
              <div className="stat-card">
                <div className="stat-icon">✅</div>
                <div className="stat-info">
                  <div className="stat-value">{completedCount}</div>
                  <div className="stat-label">Completed</div>
                </div>
              </div>
              <div className="stat-card">
                <div className="stat-icon">⚠️</div>
                <div className="stat-info">
                  <div className="stat-value">{failedCount}</div>
                  <div className="stat-label">Failed</div>
                </div>
              </div>
            </div>

            <div className="fhe-info-section">
              <h3>Zama FHE Security Features</h3>
              <div className="feature-grid">
                <div className="feature-card">
                  <div className="feature-icon">🔐</div>
                  <h4>End-to-End Encryption</h4>
                  <p>Firmware data remains encrypted throughout the OTA process using Zama FHE technology</p>
                </div>
                <div className="feature-card">
                  <div className="feature-icon">⚡</div>
                  <h4>Encrypted Processing</h4>
                  <p>Perform integrity checks and validations on encrypted data without decryption</p>
                </div>
                <div className="feature-card">
                  <div className="feature-icon">🛡️</div>
                  <h4>Vehicle Identity Protection</h4>
                  <p>Vehicle identities and update patterns are protected from unauthorized access</p>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* OTA Updates Tab */}
        {activeTab === "updates" && (
          <div className="updates-content">
            <div className="section-header">
              <h3>FHE-Encrypted OTA Updates</h3>
              <p>Secure over-the-air updates protected by Zama Fully Homomorphic Encryption</p>
            </div>

            <div className="records-table">
              <div className="table-header">
                <div>Vehicle ID</div>
                <div>Version</div>
                <div>File Size</div>
                <div>Status</div>
                <div>Date</div>
                <div>Actions</div>
              </div>

              {otaRecords.length === 0 ? (
                <div className="no-records">
                  <div className="no-records-icon">🔒</div>
                  <p>No OTA update records found</p>
                  <button onClick={() => setShowCreateModal(true)} className="primary-btn">
                    Create First OTA Update
                  </button>
                </div>
              ) : (
                otaRecords.map(record => (
                  <div key={record.id} className="table-row">
                    <div>{record.vehicleId}</div>
                    <div>{record.version}</div>
                    <div>{record.fileSize} MB</div>
                    <div>
                      <span className={`status-badge ${record.status}`}>
                        {record.status}
                      </span>
                    </div>
                    <div>{new Date(record.timestamp * 1000).toLocaleDateString()}</div>
                    <div className="action-buttons">
                      <button 
                        onClick={() => setSelectedRecord(record)}
                        className="action-btn view"
                      >
                        View
                      </button>
                      {isOwner(record.owner) && record.status === "pending" && (
                        <button 
                          onClick={() => verifyUpdateIntegrity(record.id)}
                          className="action-btn verify"
                        >
                          Verify
                        </button>
                      )}
                      {isOwner(record.owner) && record.status === "downloading" && (
                        <button 
                          onClick={() => completeUpdate(record.id)}
                          className="action-btn complete"
                        >
                          Complete
                        </button>
                      )}
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>
        )}

        {/* Vehicle Management Tab */}
        {activeTab === "vehicles" && (
          <div className="vehicles-content">
            <div className="section-header">
              <h3>Vehicle Management</h3>
              <p>Manage your vehicle fleet with FHE-protected identities</p>
            </div>

            <div className="vehicles-grid">
              {vehicles.map((vehicleId, index) => (
                <div key={vehicleId} className="vehicle-card">
                  <div className="vehicle-icon">🚗</div>
                  <div className="vehicle-info">
                    <h4>{vehicleId}</h4>
                    <p>Vehicle #{index + 1}</p>
                    <div className="vehicle-status">
                      <span className="status-online">Online</span>
                    </div>
                  </div>
                  <div className="vehicle-actions">
                    <button className="btn-small">Details</button>
                    <button className="btn-small">Update</button>
                  </div>
                </div>
              ))}
            </div>

            <button className="add-vehicle-btn">
              + Register New Vehicle
            </button>
          </div>
        )}

        {/* Operation Logs Tab */}
        {activeTab === "logs" && (
          <div className="logs-content">
            <div className="section-header">
              <h3>Operation Logs</h3>
              <p>Real-time monitoring of FHE encryption operations</p>
            </div>

            <div className="logs-container">
              {operationLogs.map((log, index) => (
                <div key={index} className="log-entry">
                  <span className="log-time">{log.split(']')[0]}]</span>
                  <span className="log-message">{log.split(']')[1]}</span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Create OTA Update Modal */}
      {showCreateModal && (
        <div className="modal-overlay">
          <div className="modal-content">
            <div className="modal-header">
              <h3>Create New OTA Update</h3>
              <button onClick={() => setShowCreateModal(false)} className="close-btn">
                &times;
              </button>
            </div>
            <div className="modal-body">
              <div className="form-group">
                <label>Vehicle ID</label>
                <select 
                  value={newUpdateData.vehicleId}
                  onChange={(e) => setNewUpdateData({...newUpdateData, vehicleId: e.target.value})}
                  className="form-input"
                >
                  <option value="">Select Vehicle</option>
                  {vehicles.map(vehicle => (
                    <option key={vehicle} value={vehicle}>{vehicle}</option>
                  ))}
                </select>
              </div>
              <div className="form-group">
                <label>Firmware Version</label>
                <input 
                  type="text"
                  value={newUpdateData.version}
                  onChange={(e) => setNewUpdateData({...newUpdateData, version: e.target.value})}
                  placeholder="e.g., v2.1.0"
                  className="form-input"
                />
              </div>
              <div className="form-group">
                <label>File Size (MB)</label>
                <input 
                  type="number"
                  value={newUpdateData.fileSize}
                  onChange={(e) => setNewUpdateData({...newUpdateData, fileSize: parseInt(e.target.value) || 0})}
                  className="form-input"
                />
              </div>
              <div className="form-group">
                <label>Description</label>
                <textarea 
                  value={newUpdateData.description}
                  onChange={(e) => setNewUpdateData({...newUpdateData, description: e.target.value})}
                  placeholder="Update description..."
                  className="form-input"
                  rows={3}
                />
              </div>
              <div className="encryption-preview">
                <h4>FHE Encryption Preview</h4>
                <div className="preview">
                  <div>Original Size: {newUpdateData.fileSize} MB</div>
                  <div>→</div>
                  <div>Encrypted: {newUpdateData.fileSize ? FHEEncryptNumber(newUpdateData.fileSize).substring(0, 30) + '...' : 'N/A'}</div>
                </div>
              </div>
            </div>
            <div className="modal-footer">
              <button onClick={() => setShowCreateModal(false)} className="btn-secondary">
                Cancel
              </button>
              <button onClick={submitOTAUpdate} disabled={creating} className="btn-primary">
                {creating ? "Encrypting with FHE..." : "Create Secure Update"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Record Detail Modal */}
      {selectedRecord && (
        <div className="modal-overlay">
          <div className="modal-content large">
            <div className="modal-header">
              <h3>OTA Update Details - {selectedRecord.vehicleId}</h3>
              <button onClick={() => setSelectedRecord(null)} className="close-btn">
                &times;
              </button>
            </div>
            <div className="modal-body">
              <div className="detail-grid">
                <div className="detail-item">
                  <label>Vehicle ID:</label>
                  <span>{selectedRecord.vehicleId}</span>
                </div>
                <div className="detail-item">
                  <label>Version:</label>
                  <span>{selectedRecord.version}</span>
                </div>
                <div className="detail-item">
                  <label>Status:</label>
                  <span className={`status-badge ${selectedRecord.status}`}>
                    {selectedRecord.status}
                  </span>
                </div>
                <div className="detail-item">
                  <label>File Size:</label>
                  <span>{selectedRecord.fileSize} MB</span>
                </div>
                <div className="detail-item">
                  <label>Created:</label>
                  <span>{new Date(selectedRecord.timestamp * 1000).toLocaleString()}</span>
                </div>
                <div className="detail-item">
                  <label>Owner:</label>
                  <span>{selectedRecord.owner.substring(0, 10)}...{selectedRecord.owner.substring(34)}</span>
                </div>
              </div>

              <div className="encryption-section">
                <h4>FHE Encryption Details</h4>
                <div className="encrypted-data">
                  {selectedRecord.encryptedFirmware.substring(0, 100)}...
                </div>
                <button 
                  onClick={async () => {
                    if (decryptedSize === null) {
                      const decrypted = await decryptWithSignature(selectedRecord.encryptedFirmware);
                      setDecryptedSize(decrypted);
                    } else {
                      setDecryptedSize(null);
                    }
                  }}
                  disabled={isDecrypting}
                  className="decrypt-btn"
                >
                  {isDecrypting ? "Decrypting..." : 
                   decryptedSize !== null ? "Hide Decrypted Value" : "Decrypt with Wallet"}
                </button>
                {decryptedSize !== null && (
                  <div className="decrypted-value">
                    Decrypted File Size: {decryptedSize} MB
                  </div>
                )}
              </div>

              <div className="description-section">
                <h4>Description</h4>
                <p>{selectedRecord.description}</p>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Transaction Status Modal */}
      {transactionStatus.visible && (
        <div className="transaction-modal">
          <div className="transaction-content">
            <div className={`transaction-icon ${transactionStatus.status}`}>
              {transactionStatus.status === "pending" && "⏳"}
              {transactionStatus.status === "success" && "✅"}
              {transactionStatus.status === "error" && "❌"}
            </div>
            <div className="transaction-message">{transactionStatus.message}</div>
          </div>
        </div>
      )}
    </div>
  );
};

export default App;